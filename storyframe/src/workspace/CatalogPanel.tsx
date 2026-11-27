import { useEffect, useState } from "react";
import type { ProductAdConceptRecord } from "../../shared/ad-concept-contract";
import type { CampaignRecord, ProductRecord } from "../../shared/product-contract";
import type { ProjectSummary } from "../../shared/project-contract";
import type { ReadyImageOption } from "../../shared/media-contract";
import {
  AiRequestError,
  applyAdConceptToProject,
  createCampaign,
  createProduct,
  deleteCampaign,
  deleteProduct,
  generateAdConcepts,
  listAdConceptSets,
  listCampaigns,
  listProducts,
  listProjects,
  listReadyImages,
  selectAdConcept,
  updateCampaign,
  updateProduct,
} from "../api";

interface CatalogPanelProps {
  getAccessToken: () => Promise<string>;
  onBusyChange?: (busy: boolean) => void;
}

interface ClaimDraft {
  text: string;
  evidence: string;
}

const EMPTY_PRODUCT = {
  name: "",
  variant: "",
  voice: "",
  colors: "",
  notes: "",
  prohibited: "",
  assetIds: [] as string[],
  logoId: "",
};

const EMPTY_CAMPAIGN = {
  productId: "",
  projectId: "",
  audience: "",
  offer: "",
  price: "24.50",
  currency: "USD",
  promotionStart: "",
  promotionEnd: "",
  timezone: "UTC",
  cta: "",
  destination: "",
  durationSeconds: "15",
  aspectRatio: "16:9",
  disclaimer: "",
};

function messageFor(cause: unknown): string {
  return cause instanceof AiRequestError ? cause.message : "The request could not be completed.";
}

function commaList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function isoOrNull(value: string): string | null {
  if (!value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The server stores UTC; `datetime-local` edits in the browser's local time. */
function datetimeLocal(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** The fields shared by campaign creation and correction; the product is fixed. */
function campaignFieldsFrom(form: typeof EMPTY_CAMPAIGN) {
  return {
    projectId: form.projectId || null,
    audience: form.audience,
    offer: form.offer,
    price: Number(form.price),
    currency: form.currency.toUpperCase(),
    promotionStart: isoOrNull(form.promotionStart),
    promotionEnd: isoOrNull(form.promotionEnd),
    timezone: form.timezone,
    cta: form.cta,
    destination: form.destination,
    durationSeconds: Number(form.durationSeconds),
    aspectRatio: form.aspectRatio as CampaignRecord["aspectRatio"],
    disclaimer: form.disclaimer,
  };
}

/** Names a ready image by its project and upload facts, never by its UUID. */
function readyImageLabel(image: ReadyImageOption): string {
  const project = image.projectTitle.trim() || `Project ${image.projectId.slice(0, 8)}`;
  const format = image.contentType.replace(/^image\//i, "").toUpperCase() || "IMAGE";
  const size =
    image.byteSize >= 1024 * 1024
      ? `${(image.byteSize / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(image.byteSize / 1024))} KB`;
  const credit = image.provenance ? ` · ${image.provenance.provider} by ${image.provenance.creator}` : "";
  return `${project} · ${format} · ${size} · ${image.createdAt.slice(0, 10)}${credit}`;
}

export function CatalogPanel({ getAccessToken, onBusyChange }: CatalogPanelProps) {
  const [products, setProducts] = useState<ProductRecord[] | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [readyImages, setReadyImages] = useState<ReadyImageOption[] | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignRecord[]>([]);
  const [conceptSets, setConceptSets] = useState<ProductAdConceptRecord[]>([]);
  const [selectedProductId, setSelectedProductId] = useState("");
  const [selectedCampaignId, setSelectedCampaignId] = useState("");
  const [productForm, setProductForm] = useState(EMPTY_PRODUCT);
  const [claims, setClaims] = useState<ClaimDraft[]>([{ text: "", evidence: "" }]);
  const [campaignForm, setCampaignForm] = useState(EMPTY_CAMPAIGN);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savingProduct, setSavingProduct] = useState(false);
  const [savingCampaign, setSavingCampaign] = useState(false);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [editingCampaignId, setEditingCampaignId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<"product" | "campaign" | null>(null);
  const [deleting, setDeleting] = useState<"product" | "campaign" | null>(null);

  async function load(shouldApply: () => boolean = () => true) {
    const token = await getAccessToken();
    const [productList, campaignList, conceptList, projectList, imageList] = await Promise.all([
      listProducts(token),
      listCampaigns(token),
      listAdConceptSets(token),
      listProjects(token),
      listReadyImages(token),
    ]);
    if (!shouldApply()) return;
    const firstProductId = productList[0]?.id ?? "";
    setProducts(productList);
    setCampaigns(campaignList);
    setConceptSets(conceptList);
    setProjects(projectList);
    setReadyImages(imageList);
    setSelectedProductId((current) =>
      current && productList.some((product) => product.id === current) ? current : firstProductId,
    );
    setSelectedCampaignId((current) =>
      current && campaignList.some((campaign) => campaign.id === current) ? current : "",
    );
    if (editingProductId && !productList.some((product) => product.id === editingProductId)) {
      cancelProductEdit();
    }
    if (editingCampaignId && !campaignList.some((campaign) => campaign.id === editingCampaignId)) {
      cancelCampaignEdit(firstProductId);
    }
    setCampaignForm((current) => {
      if (editingCampaignId) return current;
      const productId =
        current.productId && productList.some((product) => product.id === current.productId)
          ? current.productId
          : firstProductId;
      return { ...current, productId };
    });
  }

  useEffect(() => {
    let active = true;
    setError(null);
    load(() => active).catch((cause) => {
      if (active) setError(messageFor(cause));
    });
    return () => {
      active = false;
    };
    // The catalog loads once; explicit buttons refresh it after a write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const productCampaigns = campaigns.filter(
    (campaign) => !selectedProductId || campaign.productId === selectedProductId,
  );
  const selectedProduct = products?.find((product) => product.id === selectedProductId) ?? null;
  const productConceptSets = conceptSets.filter(
    (set) => !selectedProductId || set.productId === selectedProductId,
  );
  const activeCampaign =
    productCampaigns.find((campaign) => campaign.id === selectedCampaignId) ?? productCampaigns[0] ?? null;
  const readyImageIds = new Set((readyImages ?? []).map((image) => image.id));
  const unavailableAssetIds =
    readyImages === null ? [] : productForm.assetIds.filter((id) => !readyImageIds.has(id));
  const unavailableLogo =
    readyImages !== null && productForm.logoId.length > 0 && !readyImageIds.has(productForm.logoId);
  const unavailableProject =
    campaignForm.projectId.length > 0 && !projects.some((project) => project.id === campaignForm.projectId);

  function resetProductFields() {
    setProductForm(EMPTY_PRODUCT);
    setClaims([{ text: "", evidence: "" }]);
  }

  function resetCampaignFields(productId = "") {
    setCampaignForm({ ...EMPTY_CAMPAIGN, productId });
  }

  function cancelProductEdit() {
    setEditingProductId(null);
    resetProductFields();
  }

  function cancelCampaignEdit(productId = "") {
    setEditingCampaignId(null);
    resetCampaignFields(productId);
  }

  function beginProductEdit(product: ProductRecord) {
    if (editingCampaignId) cancelCampaignEdit(product.id);
    setEditingProductId(product.id);
    setProductForm({
      name: product.name,
      variant: product.variant,
      voice: product.brandSettings.voice,
      colors: product.brandSettings.colors,
      notes: product.brandSettings.notes,
      prohibited: product.prohibitedWording.join(", "),
      assetIds: [...product.assetMediaIds],
      logoId: product.logoMediaId ?? "",
    });
    setClaims(
      product.approvedClaims.length > 0
        ? product.approvedClaims.map((claim) => ({ text: claim.text, evidence: claim.evidence }))
        : [{ text: "", evidence: "" }],
    );
    setConfirmingDelete(null);
    setError(null);
    setNotice(null);
  }

  function beginCampaignEdit(campaign: CampaignRecord) {
    if (editingProductId) cancelProductEdit();
    setConfirmingDelete(null);
    setEditingCampaignId(campaign.id);
    setSelectedProductId(campaign.productId);
    setSelectedCampaignId(campaign.id);
    setCampaignForm({
      productId: campaign.productId,
      projectId: campaign.projectId ?? "",
      audience: campaign.audience,
      offer: campaign.offer,
      price: String(campaign.price),
      currency: campaign.currency,
      promotionStart: datetimeLocal(campaign.promotionStart),
      promotionEnd: datetimeLocal(campaign.promotionEnd),
      timezone: campaign.timezone,
      cta: campaign.cta,
      destination: campaign.destination,
      durationSeconds: String(campaign.durationSeconds),
      aspectRatio: campaign.aspectRatio,
      disclaimer: campaign.disclaimer,
    });
    setConfirmingDelete(null);
    setError(null);
    setNotice(null);
  }

  function selectProduct(productId: string) {
    setSelectedProductId(productId);
    setConfirmingDelete(null);
    if (editingProductId) cancelProductEdit();
    if (editingCampaignId) cancelCampaignEdit(productId);
  }

  function selectCampaign(campaignId: string) {
    setSelectedCampaignId(campaignId);
    setConfirmingDelete(null);
    if (editingCampaignId) cancelCampaignEdit(selectedProductId);
  }

  async function submitProduct() {
    if (savingProduct) return;
    if (!productForm.name.trim()) {
      setError("A product name is required.");
      return;
    }
    setSavingProduct(true);
    setError(null);
    setNotice(null);
    onBusyChange?.(true);
    try {
      const token = await getAccessToken();
      const body = {
        name: productForm.name,
        variant: productForm.variant,
        brandSettings: {
          voice: productForm.voice,
          colors: productForm.colors,
          notes: productForm.notes,
        },
        approvedClaims: claims
          .filter((claim) => claim.text.trim().length > 0)
          .map((claim) => ({ text: claim.text, evidence: claim.evidence })),
        prohibitedWording: commaList(productForm.prohibited),
        assetMediaIds: productForm.assetIds,
        logoMediaId: productForm.logoId || null,
      };
      const product = editingProductId
        ? await updateProduct(token, editingProductId, body)
        : await createProduct(token, body);
      setProducts((current) =>
        editingProductId
          ? (current ?? []).map((item) => (item.id === product.id ? product : item))
          : [product, ...(current ?? [])],
      );
      setSelectedProductId(product.id);
      setCampaignForm((current) => ({ ...current, productId: product.id }));
      cancelProductEdit();
      setNotice(`Saved product "${product.name}".`);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setSavingProduct(false);
      onBusyChange?.(false);
    }
  }

  async function submitCampaign() {
    if (savingCampaign) return;
    if (!campaignForm.productId) {
      setError("Choose a product before creating a campaign.");
      return;
    }
    setSavingCampaign(true);
    setError(null);
    setNotice(null);
    onBusyChange?.(true);
    try {
      const token = await getAccessToken();
      const fields = campaignFieldsFrom(campaignForm);
      const campaign = editingCampaignId
        ? await updateCampaign(token, editingCampaignId, fields)
        : await createCampaign(token, { productId: campaignForm.productId, ...fields });
      setCampaigns((current) =>
        editingCampaignId
          ? current.map((item) => (item.id === campaign.id ? campaign : item))
          : [campaign, ...current],
      );
      setSelectedProductId(campaign.productId);
      setSelectedCampaignId(campaign.id);
      cancelCampaignEdit(campaign.productId);
      setConfirmingDelete(null);
      setNotice(`Saved campaign "${campaign.cta}".`);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setSavingCampaign(false);
      onBusyChange?.(false);
    }
  }

  async function generate() {
    if (generating || !selectedProductId) return;
    const campaign = activeCampaign;
    if (!campaign) {
      setError("Create a campaign for this product before generating concepts.");
      return;
    }
    setGenerating(true);
    setError(null);
    setNotice(null);
    onBusyChange?.(true);
    try {
      const token = await getAccessToken();
      const set = await generateAdConcepts(token, selectedProductId, campaign.id, crypto.randomUUID());
      setConceptSets((current) => [set, ...current]);
      setNotice("Three grounded concepts generated from the frozen product snapshot.");
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setGenerating(false);
      onBusyChange?.(false);
    }
  }

  async function removeProduct() {
    if (!selectedProduct || deleting) return;
    setDeleting("product");
    setError(null);
    setNotice(null);
    onBusyChange?.(true);
    try {
      const removedId = await deleteProduct(await getAccessToken(), selectedProduct.id);
      setProducts((current) => (current ?? []).filter((product) => product.id !== removedId));
      setCampaigns((current) => current.filter((campaign) => campaign.productId !== removedId));
      setConceptSets((current) => current.filter((set) => set.productId !== removedId));
      setSelectedProductId("");
      setSelectedCampaignId("");
      setConfirmingDelete(null);
      cancelProductEdit();
      cancelCampaignEdit();
      setNotice(`Deleted product "${selectedProduct.name}" and its campaigns and concept sets.`);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setDeleting(null);
      onBusyChange?.(false);
    }
  }

  async function removeCampaign() {
    const campaign = activeCampaign;
    if (!campaign || deleting) return;
    setDeleting("campaign");
    setError(null);
    setNotice(null);
    onBusyChange?.(true);
    try {
      const removedId = await deleteCampaign(await getAccessToken(), campaign.id);
      setCampaigns((current) => current.filter((item) => item.id !== removedId));
      setConceptSets((current) => current.filter((set) => set.campaignId !== removedId));
      setSelectedCampaignId("");
      setConfirmingDelete(null);
      if (editingCampaignId === removedId) cancelCampaignEdit(selectedProductId);
      setNotice(`Deleted campaign "${campaign.cta}" and its concept sets. The product remains.`);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setDeleting(null);
      onBusyChange?.(false);
    }
  }

  async function applyToProject(set: ProductAdConceptRecord) {
    if (applying) return;
    setApplying(set.id);
    setError(null);
    setNotice(null);
    onBusyChange?.(true);
    try {
      const result = await applyAdConceptToProject(await getAccessToken(), set.id);
      setNotice(
        `Applied "${set.manifest?.title ?? set.snapshot.product.name}" to "${result.project.title}" as revision ${result.projectRevision}. Open it in Projects to export the render.`,
      );
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setApplying(null);
      onBusyChange?.(false);
    }
  }

  async function chooseConcept(set: ProductAdConceptRecord, index: number) {
    if (selecting) return;
    setSelecting(set.id);
    setError(null);
    setNotice(null);
    onBusyChange?.(true);
    try {
      const selected = await selectAdConcept(await getAccessToken(), set.id, index);
      setConceptSets((current) => current.map((item) => (item.id === selected.id ? selected : item)));
      setNotice("Concept selected; its manifest is frozen from the same snapshot.");
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setSelecting(null);
      onBusyChange?.(false);
    }
  }

  return (
    <section className="panel editor-panel" aria-labelledby="catalog-heading">
      <div className="panel-heading">
        <h2 id="catalog-heading">Product ads</h2>
        <span className="status">
          {products ? `${products.length} product${products.length === 1 ? "" : "s"}` : "Loading"}
        </span>
      </div>
      <p className="muted editor-intro">
        A product ad is generated only from approved facts. The catalog keeps the real name, the claims you can
        evidence, the wording that must never appear, and the campaign offer. Generating copies those facts into a
        frozen snapshot, so a later edit cannot rewrite an approved concept.
      </p>

      {error && (
        <div className="alert" role="alert">
          <p>{error}</p>
        </div>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      <div className="button-row">
        <button
          type="button"
          className="button-secondary button-small"
          disabled={deleting !== null}
          onClick={() => {
            setError(null);
            load().catch((cause) => setError(messageFor(cause)));
          }}
        >
          Refresh catalog
        </button>
      </div>

      <div className="catalog-block">
        <h3>{editingProductId ? "Edit product" : "New product"}</h3>
        <div className="catalog-grid">
          <label className="field" htmlFor="product-name">
            <span className="field-label">Name</span>
            <input
              id="product-name"
              value={productForm.name}
              maxLength={200}
              onChange={(event) => setProductForm({ ...productForm, name: event.target.value })}
            />
          </label>
          <label className="field" htmlFor="product-variant">
            <span className="field-label">Variant</span>
            <input
              id="product-variant"
              value={productForm.variant}
              maxLength={200}
              onChange={(event) => setProductForm({ ...productForm, variant: event.target.value })}
            />
          </label>
          <label className="field" htmlFor="product-voice">
            <span className="field-label">Brand voice</span>
            <input
              id="product-voice"
              value={productForm.voice}
              maxLength={500}
              onChange={(event) => setProductForm({ ...productForm, voice: event.target.value })}
            />
          </label>
          <label className="field" htmlFor="product-colors">
            <span className="field-label">Brand colours</span>
            <input
              id="product-colors"
              value={productForm.colors}
              maxLength={500}
              onChange={(event) => setProductForm({ ...productForm, colors: event.target.value })}
            />
          </label>
          <label className="field" htmlFor="product-notes">
            <span className="field-label">Brand notes</span>
            <input
              id="product-notes"
              value={productForm.notes}
              maxLength={500}
              onChange={(event) => setProductForm({ ...productForm, notes: event.target.value })}
            />
          </label>
          <label className="field" htmlFor="product-prohibited">
            <span className="field-label">Prohibited wording (comma separated, up to 12)</span>
            <input
              id="product-prohibited"
              value={productForm.prohibited}
              onChange={(event) => setProductForm({ ...productForm, prohibited: event.target.value })}
            />
          </label>
        </div>

        <fieldset className="media-picker-field">
          <legend className="field-label">
            Product images
            {productForm.assetIds.length > 0 ? ` (${productForm.assetIds.length} selected)` : ""}
          </legend>
          <p className="hint">
            Pick up to 12 ready images from any of your projects. They ground the concepts, and a beat may show only an
            image picked here.
          </p>
          {unavailableAssetIds.length > 0 && (
            <p className="hint">
              {unavailableAssetIds.length} selected image{unavailableAssetIds.length === 1 ? " is" : "s are"} no
              longer ready. Saving keeps them unless you clear the list or replace them.
            </p>
          )}
          {readyImages === null ? (
            <p className="hint">Loading ready images...</p>
          ) : readyImages.length === 0 ? (
            <p className="hint">
              No ready images yet. Upload product photos in a project&apos;s Media panel, then refresh the catalog.
            </p>
          ) : (
            <div className="media-picker">
              {readyImages.map((image) => (
                <label className="media-option" key={image.id}>
                  <input
                    type="checkbox"
                    checked={productForm.assetIds.includes(image.id)}
                    disabled={
                      productForm.assetIds.length >= 12 && !productForm.assetIds.includes(image.id)
                    }
                    onChange={(event) =>
                      setProductForm((current) => ({
                        ...current,
                        assetIds: event.target.checked
                          ? [...current.assetIds, image.id]
                          : current.assetIds.filter((id) => id !== image.id),
                      }))
                    }
                  />
                  <span>{readyImageLabel(image)}</span>
                </label>
              ))}
            </div>
          )}
          {productForm.assetIds.length > 0 && (
            <div className="button-row">
              <button
                type="button"
                className="button-secondary button-small"
                onClick={() => setProductForm((current) => ({ ...current, assetIds: [] }))}
              >
                Clear product images
              </button>
            </div>
          )}
          <label className="field" htmlFor="product-logo">
            <span className="field-label">Logo image</span>
            <select
              id="product-logo"
              value={productForm.logoId}
              onChange={(event) => setProductForm({ ...productForm, logoId: event.target.value })}
            >
              <option value="">No logo</option>
              {unavailableLogo && (
                <option value={productForm.logoId}>Unavailable image (current selection)</option>
              )}
              {readyImages?.map((image) => (
                <option key={image.id} value={image.id}>
                  {readyImageLabel(image)}
                </option>
              ))}
            </select>
          </label>
        </fieldset>

        <h4>Approved claims (up to 8)</h4>
        <p className="hint">A claim without an evidence note is stored but can never be used by a concept.</p>
        {claims.map((claim, index) => (
          <div className="claim-row" key={index}>
            <label className="field" htmlFor={`claim-text-${index}`}>
              <span className="field-label">Claim {index + 1}</span>
              <input
                id={`claim-text-${index}`}
                value={claim.text}
                maxLength={300}
                onChange={(event) =>
                  setClaims((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, text: event.target.value } : item,
                    ),
                  )
                }
              />
            </label>
            <label className="field" htmlFor={`claim-evidence-${index}`}>
              <span className="field-label">Evidence for claim {index + 1}</span>
              <input
                id={`claim-evidence-${index}`}
                value={claim.evidence}
                maxLength={400}
                onChange={(event) =>
                  setClaims((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, evidence: event.target.value } : item,
                    ),
                  )
                }
              />
            </label>
            <button
              type="button"
              className="button-secondary button-small"
              onClick={() => setClaims((current) => current.filter((_, itemIndex) => itemIndex !== index))}
              disabled={claims.length === 1}
            >
              Remove claim
            </button>
          </div>
        ))}
        <div className="button-row">
          <button
            type="button"
            className="button-secondary button-small"
            onClick={() => setClaims((current) => [...current, { text: "", evidence: "" }])}
            disabled={claims.length >= 8}
          >
            Add claim
          </button>
          <button
            type="button"
            onClick={() => void submitProduct()}
            disabled={savingProduct || deleting !== null}
          >
            {savingProduct ? "Saving..." : editingProductId ? "Save product" : "Create product"}
          </button>
          {editingProductId && (
            <button
              type="button"
              className="button-secondary"
              onClick={() => cancelProductEdit()}
              disabled={savingProduct || deleting !== null}
            >
              Cancel product edit
            </button>
          )}
        </div>
      </div>

      <div className="catalog-block">
        <h3>{editingCampaignId ? "Edit campaign" : "New campaign"}</h3>
        <div className="catalog-grid">
          <label className="field" htmlFor="campaign-product">
            <span className="field-label">Product</span>
            <select
              id="campaign-product"
              value={campaignForm.productId}
              disabled={editingCampaignId !== null}
              onChange={(event) => setCampaignForm({ ...campaignForm, productId: event.target.value })}
            >
              <option value="">Choose a product...</option>
              {products?.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                  {product.variant ? ` — ${product.variant}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="field" htmlFor="campaign-project">
            <span className="field-label">Render project</span>
            <select
              id="campaign-project"
              value={campaignForm.projectId}
              onChange={(event) => setCampaignForm({ ...campaignForm, projectId: event.target.value })}
            >
              <option value="">No project (concepts only)</option>
              {unavailableProject && (
                <option value={campaignForm.projectId}>Unavailable project (current selection)</option>
              )}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          </label>
          <label className="field" htmlFor="campaign-audience">
            <span className="field-label">Audience</span>
            <input
              id="campaign-audience"
              value={campaignForm.audience}
              maxLength={300}
              onChange={(event) => setCampaignForm({ ...campaignForm, audience: event.target.value })}
            />
          </label>
          <label className="field" htmlFor="campaign-offer">
            <span className="field-label">Offer</span>
            <input
              id="campaign-offer"
              value={campaignForm.offer}
              maxLength={600}
              onChange={(event) => setCampaignForm({ ...campaignForm, offer: event.target.value })}
            />
          </label>
          <label className="field" htmlFor="campaign-price">
            <span className="field-label">Price</span>
            <input
              id="campaign-price"
              type="number"
              min="0"
              step="0.01"
              value={campaignForm.price}
              onChange={(event) => setCampaignForm({ ...campaignForm, price: event.target.value })}
            />
          </label>
          <label className="field" htmlFor="campaign-currency">
            <span className="field-label">Currency</span>
            <input
              id="campaign-currency"
              value={campaignForm.currency}
              maxLength={3}
              onChange={(event) => setCampaignForm({ ...campaignForm, currency: event.target.value })}
            />
          </label>
          <label className="field" htmlFor="campaign-start">
            <span className="field-label">Promotion start</span>
            <input
              id="campaign-start"
              type="datetime-local"
              value={campaignForm.promotionStart}
              onChange={(event) => setCampaignForm({ ...campaignForm, promotionStart: event.target.value })}
            />
          </label>
          <label className="field" htmlFor="campaign-end">
            <span className="field-label">Promotion end</span>
            <input
              id="campaign-end"
              type="datetime-local"
              value={campaignForm.promotionEnd}
              onChange={(event) => setCampaignForm({ ...campaignForm, promotionEnd: event.target.value })}
            />
          </label>
          <label className="field" htmlFor="campaign-timezone">
            <span className="field-label">Time zone</span>
            <input
              id="campaign-timezone"
              value={campaignForm.timezone}
              maxLength={64}
              onChange={(event) => setCampaignForm({ ...campaignForm, timezone: event.target.value })}
            />
          </label>
          <label className="field" htmlFor="campaign-cta">
            <span className="field-label">Call to action</span>
            <input
              id="campaign-cta"
              value={campaignForm.cta}
              maxLength={200}
              onChange={(event) => setCampaignForm({ ...campaignForm, cta: event.target.value })}
            />
          </label>
          <label className="field" htmlFor="campaign-destination">
            <span className="field-label">Destination URL</span>
            <input
              id="campaign-destination"
              value={campaignForm.destination}
              maxLength={1024}
              onChange={(event) => setCampaignForm({ ...campaignForm, destination: event.target.value })}
            />
          </label>
          <label className="field" htmlFor="campaign-duration">
            <span className="field-label">Duration (seconds)</span>
            <input
              id="campaign-duration"
              type="number"
              min="5"
              max="600"
              value={campaignForm.durationSeconds}
              onChange={(event) => setCampaignForm({ ...campaignForm, durationSeconds: event.target.value })}
            />
          </label>
          <label className="field" htmlFor="campaign-ratio">
            <span className="field-label">Aspect ratio</span>
            <select
              id="campaign-ratio"
              value={campaignForm.aspectRatio}
              onChange={(event) => setCampaignForm({ ...campaignForm, aspectRatio: event.target.value })}
            >
              <option value="16:9">16:9</option>
              <option value="9:16">9:16</option>
              <option value="1:1">1:1</option>
              <option value="4:5">4:5</option>
            </select>
          </label>
          <label className="field" htmlFor="campaign-disclaimer">
            <span className="field-label">Disclaimer</span>
            <input
              id="campaign-disclaimer"
              value={campaignForm.disclaimer}
              maxLength={1000}
              onChange={(event) => setCampaignForm({ ...campaignForm, disclaimer: event.target.value })}
            />
          </label>
        </div>
        <p className="hint">
          A render project must already hold the product's ready images and logo; applying a manifest adds its
          approved scenes to that project.
          {editingCampaignId
            ? " The owning product is fixed; create a new campaign for a different product."
            : ""}
        </p>
        <div className="button-row">
          <button
            type="button"
            onClick={() => void submitCampaign()}
            disabled={savingCampaign || deleting !== null}
          >
            {savingCampaign ? "Saving..." : editingCampaignId ? "Save campaign" : "Create campaign"}
          </button>
          {editingCampaignId && (
            <button
              type="button"
              className="button-secondary"
              onClick={() => cancelCampaignEdit(selectedProductId)}
              disabled={savingCampaign || deleting !== null}
            >
              Cancel campaign edit
            </button>
          )}
        </div>
      </div>

      <div className="catalog-block">
        <div className="field-label-row">
          <h3>Grounded concepts</h3>
          <select
            aria-label="Catalog product"
            value={selectedProductId}
            disabled={deleting !== null}
            onChange={(event) => selectProduct(event.target.value)}
          >
            <option value="">All products</option>
            {products?.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
          </select>
        </div>
        <p className="hint">
          {selectedProduct
            ? `${selectedProduct.approvedClaims.filter((claim) => claim.evidence.trim()).length} claim(s) with evidence · ${
                selectedProduct.assetMediaIds.length
              } product image(s)`
            : "Choose one product to generate against its frozen facts."}
        </p>
        {selectedProduct && (
          <div className="button-row">
            <button
              type="button"
              className="button-secondary button-small"
              onClick={() => beginProductEdit(selectedProduct)}
              disabled={deleting !== null}
            >
              Edit product
            </button>
            {confirmingDelete === "product" ? (
              <>
                <button
                  type="button"
                  className="button-danger button-small"
                  onClick={() => void removeProduct()}
                  disabled={deleting !== null}
                >
                  {deleting === "product" ? "Deleting..." : "Confirm delete product"}
                </button>
                <button
                  type="button"
                  className="button-secondary button-small"
                  onClick={() => setConfirmingDelete(null)}
                  disabled={deleting !== null}
                >
                  Cancel product delete
                </button>
              </>
            ) : (
              <button
                type="button"
                className="button-secondary button-small button-danger"
                onClick={() => setConfirmingDelete("product")}
                disabled={deleting !== null}
              >
                Delete product
              </button>
            )}
          </div>
        )}
        <div className="button-row">
          <label className="field" htmlFor="concept-campaign">
            <span className="field-label">Campaign</span>
            <select
              id="concept-campaign"
              value={activeCampaign?.id ?? ""}
              disabled={deleting !== null}
              onChange={(event) => selectCampaign(event.target.value)}
            >
              {productCampaigns.length === 0 && <option value="">No campaign yet</option>}
              {productCampaigns.map((campaign) => (
                <option key={campaign.id} value={campaign.id}>
                  {campaign.cta} — {campaign.offer}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void generate()}
            disabled={deleting !== null || generating || !selectedProductId || productCampaigns.length === 0}
          >
            {generating ? "Generating..." : "Generate three concepts"}
          </button>
        </div>
        {activeCampaign && (
          <div className="button-row">
            <button
              type="button"
              className="button-secondary button-small"
              onClick={() => beginCampaignEdit(activeCampaign)}
              disabled={deleting !== null}
            >
              Edit campaign
            </button>
            {confirmingDelete === "campaign" ? (
              <>
                <button
                  type="button"
                  className="button-danger button-small"
                  onClick={() => void removeCampaign()}
                  disabled={deleting !== null}
                >
                  {deleting === "campaign" ? "Deleting..." : "Confirm delete campaign"}
                </button>
                <button
                  type="button"
                  className="button-secondary button-small"
                  onClick={() => setConfirmingDelete(null)}
                  disabled={deleting !== null}
                >
                  Cancel campaign delete
                </button>
              </>
            ) : (
              <button
                type="button"
                className="button-secondary button-small button-danger"
                onClick={() => setConfirmingDelete("campaign")}
                disabled={deleting !== null}
              >
                Delete campaign
              </button>
            )}
          </div>
        )}
        {productCampaigns.length === 0 && selectedProductId && (
          <p className="hint">Create a campaign for this product first; its offer and CTA are part of the snapshot.</p>
        )}

        {products === null && <p className="muted">Loading catalog...</p>}
        {products && products.length === 0 && (
          <p className="empty-state">No products yet. Create one above to start a grounded ad.</p>
        )}
        {productConceptSets.length === 0 && products && products.length > 0 && (
          <p className="empty-state">No concept sets yet. Generate three concepts for a product with a campaign.</p>
        )}

        {productConceptSets.map((set) => (
          <article className="project-card" key={set.id}>
            <div className="project-card-header">
              <h4>{set.snapshot.product.name}</h4>
              <span className="status">{set.status === "selected" ? "Selected" : "Proposed"}</span>
            </div>
            <p className="hint">
              Snapshot {set.snapshotHash.slice(0, 12)}… · {set.snapshot.campaign.cta} ·{" "}
              {set.snapshot.campaign.aspectRatio} · {set.snapshot.campaign.durationSeconds}s
            </p>
            <p>{set.summary}</p>
            <div className="project-grid">
              {set.concepts.map((concept, index) => (
                <div className="project-card" key={concept.id}>
                  <h5>{concept.title}</h5>
                  <p>{concept.hook}</p>
                  <ul className="revision-list">
                    {concept.hookVariants.map((variant) => (
                      <li key={variant}>
                        <span className="hint">{variant}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="hint">
                    {concept.beats.length} beats · {concept.totalSeconds}s
                  </p>
                  {set.status === "selected" ? (
                    set.selectedIndex === index ? (
                      <span className="status status-ok">Selected concept</span>
                    ) : null
                  ) : (
                    <button
                      type="button"
                      className="button-secondary button-small"
                      onClick={() => void chooseConcept(set, index)}
                      disabled={deleting !== null || selecting !== null}
                    >
                      {selecting === set.id ? "Selecting..." : `Select concept ${index + 1}`}
                    </button>
                  )}
                </div>
              ))}
            </div>
            {set.manifest && (
              <>
                <div className="button-row">
                  <button
                    type="button"
                    className="button-secondary button-small"
                    onClick={() => void applyToProject(set)}
                    disabled={deleting !== null || applying !== null}
                  >
                    {applying === set.id ? "Applying..." : "Apply to project"}
                  </button>
                  <span className="hint">
                    {set.manifest.projectId
                      ? "Saves the approved scenes into the campaign's render project."
                      : "Set the campaign's render project before applying."}
                  </span>
                </div>
                <details>
                  <summary>Frozen manifest</summary>
                  <pre>{JSON.stringify(set.manifest, null, 2)}</pre>
                </details>
              </>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
