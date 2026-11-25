import { useEffect, useRef, useState } from "react";
import type { GenerationProposalRecord } from "../../shared/child-contract";
import type {
  PlanningAngle,
  PlanningClaim,
  PlanningClip,
  PlanningPayload,
  PlanningRoute,
  PlanningSceneDraft,
} from "../../shared/planning-contract";
import {
  PLANNING_ROUTES,
  PLANNING_ROUTE_HINTS,
  PLANNING_ROUTE_LABELS,
} from "../../shared/planning-contract";
import type { ProjectRecord, ProjectScene } from "../../shared/project-contract";
import {
  AiRequestError,
  acceptPlanningProposal,
  generatePlanningProposal,
  listProjectProposals,
  rejectPlanningProposal,
} from "../api";

interface PlanningPanelProps {
  projectId: string;
  baseVersion: number;
  scenes: ProjectScene[];
  dirty: boolean;
  getAccessToken: () => Promise<string>;
  onAccepted: (project: ProjectRecord) => void;
  onBusyChange?: (busy: boolean) => void;
}

function toRequestError(cause: unknown): AiRequestError {
  if (cause instanceof AiRequestError) return cause;
  return new AiRequestError(
    "NETWORK_ERROR",
    cause instanceof Error ? cause.message : "The request could not be completed.",
    0,
  );
}

function payloadOf(proposal: GenerationProposalRecord): Partial<PlanningPayload> {
  return proposal.proposal as Partial<PlanningPayload>;
}

function listOf<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

const PENDING_KEY_PREFIX = "storyframe.planning.pendingKey.";
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** The request identity a key was minted for; the server hashes route and prompt. */
interface PendingPlanningAttempt {
  key: string;
  route: PlanningRoute;
  instruction: string;
  baseVersion: number;
}

function pendingKeyStorageName(projectId: string): string {
  return `${PENDING_KEY_PREFIX}${projectId}`;
}

function isSameRequest(attempt: PendingPlanningAttempt, route: PlanningRoute, instruction: string, baseVersion: number) {
  return attempt.route === route && attempt.instruction === instruction && attempt.baseVersion === baseVersion;
}

/** Survives a reload in this tab, so Retry can still replay an unsettled attempt. */
function readPendingAttempt(projectId: string): PendingPlanningAttempt | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(pendingKeyStorageName(projectId));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (
      typeof record.key !== "string" ||
      !IDEMPOTENCY_KEY_PATTERN.test(record.key) ||
      typeof record.route !== "string" ||
      !PLANNING_ROUTES.includes(record.route as PlanningRoute) ||
      typeof record.instruction !== "string" ||
      typeof record.baseVersion !== "number" ||
      !Number.isInteger(record.baseVersion) ||
      record.baseVersion < 1
    ) {
      return null;
    }
    return {
      key: record.key,
      route: record.route as PlanningRoute,
      instruction: record.instruction,
      baseVersion: record.baseVersion,
    };
  } catch {
    return null;
  }
}

function storePendingAttempt(projectId: string, attempt: PendingPlanningAttempt): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(pendingKeyStorageName(projectId), JSON.stringify(attempt));
  } catch {
    // Storage can be unavailable (private mode); the attempt still works in memory.
  }
}

function clearPendingAttempt(projectId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(pendingKeyStorageName(projectId));
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

function newIdempotencyKey(): string {
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return uuid.replace(/[^A-Za-z0-9._:-]/g, "-");
}

/** A retry with the same key is the safe option while the attempt's fate is unknown. */
function keepsKeyOnRetry(error: AiRequestError): boolean {
  return (
    error.status === 0 ||
    error.code === "IDEMPOTENCY_IN_PROGRESS" ||
    error.code === "LEDGER_UNAVAILABLE"
  );
}

function statusLabel(status: GenerationProposalRecord["status"]): string {
  if (status === "accepted") return "Accepted";
  if (status === "rejected") return "Rejected";
  return "Proposed";
}

function ScenarioList({ scenes }: { scenes: PlanningSceneDraft[] }) {
  return (
    <ol className="planning-list">
      {scenes.map((scene, index) => (
        <li key={`${index}-${scene.heading}`}>
          <p>
            <strong>
              Scene {index + 1}: {scene.heading}
            </strong>{" "}
            <span className="hint">{scene.durationSeconds}s</span>
          </p>
          <p>{scene.narration}</p>
          {scene.visualDirection && <p className="hint">Visual: {scene.visualDirection}</p>}
          {scene.onScreenText && <p className="hint">On screen: {scene.onScreenText}</p>}
        </li>
      ))}
    </ol>
  );
}

function AngleList({ angles }: { angles: PlanningAngle[] }) {
  return (
    <ol className="planning-list">
      {angles.map((angle, index) => (
        <li key={`${index}-${angle.title}`}>
          <p>
            <strong>{angle.title}</strong>
          </p>
          <p>{angle.hook}</p>
          <p className="hint">{angle.rationale}</p>
        </li>
      ))}
    </ol>
  );
}

function ClipList({ clips }: { clips: PlanningClip[] }) {
  return (
    <ol className="planning-list">
      {clips.map((clip, index) => (
        <li key={`${index}-${clip.startSeconds}`}>
          <p>
            <strong>
              {clip.startSeconds}s–{clip.endSeconds}s: {clip.heading}
            </strong>
          </p>
          <p>“{clip.quote}”</p>
          <p className="hint">{clip.rationale}</p>
        </li>
      ))}
    </ol>
  );
}

function ClaimList({ claims }: { claims: PlanningClaim[] }) {
  return (
    <ul className="planning-list">
      {claims.map((claim, index) => (
        <li key={`${index}-${claim.statement.slice(0, 24)}`}>
          <p>
            <span className={claim.supported ? "status status-ok" : "status"}>
              {claim.supported ? "Supported" : "Unverified"}
            </span>{" "}
            {claim.statement}
          </p>
          {claim.quote ? <p className="hint">“{claim.quote}”</p> : <p className="hint">No supporting quote supplied.</p>}
        </li>
      ))}
    </ul>
  );
}

export function PlanningPanel({
  projectId,
  baseVersion,
  scenes,
  dirty,
  getAccessToken,
  onAccepted,
  onBusyChange,
}: PlanningPanelProps) {
  const [route, setRoute] = useState<PlanningRoute>("angles");
  const [instruction, setInstruction] = useState("");
  const [proposals, setProposals] = useState<GenerationProposalRecord[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<AiRequestError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Reused only while an attempt's outcome is unknown, so a retry replays the
  // recorded proposal instead of paying for another one.
  const pendingAttempt = useRef<PendingPlanningAttempt | null>(null);

  const busy = generating || acting;

  // A different project is a different attempt; never carry a key across it.
  useEffect(() => {
    pendingAttempt.current = null;
  }, [projectId]);

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const list = await listProjectProposals(await getAccessToken(), projectId);
        if (!active) return;
        setProposals(list);
        setSelectedId((current) => current ?? list[list.length - 1]?.id ?? null);
      } catch (cause) {
        if (active) setError(toRequestError(cause));
      }
    })();
    return () => {
      active = false;
    };
    // The list is tied to the project; token changes are handled by the helper.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const selected = proposals?.find((proposal) => proposal.id === selectedId) ?? null;
  const selectedPayload = selected ? payloadOf(selected) : null;
  const canAct = Boolean(selected && selected.status === "proposed" && !dirty && !busy);

  async function handleGenerate() {
    if (generating || dirty) return;
    setGenerating(true);
    setError(null);
    setNotice(null);
    const previous = pendingAttempt.current ?? readPendingAttempt(projectId);
    const key =
      previous && isSameRequest(previous, route, instruction, baseVersion)
        ? previous.key
        : newIdempotencyKey();
    // A changed request can never replay the old attempt (the server hashes the
    // exact prompt), so keeping the old key would only produce a 409 reuse.
    pendingAttempt.current = { key, route, instruction, baseVersion };
    storePendingAttempt(projectId, pendingAttempt.current);
    try {
      const created = await generatePlanningProposal(
        await getAccessToken(),
        projectId,
        { route, instruction, baseVersion },
        key,
      );
      pendingAttempt.current = null;
      clearPendingAttempt(projectId);
      // A replayed attempt may already be in the list loaded after a reload.
      setProposals((current) => {
        const list = current ?? [];
        return list.some((proposal) => proposal.id === created.id)
          ? list.map((proposal) => (proposal.id === created.id ? created : proposal))
          : [...list, created];
      });
      setSelectedId(created.id);
      setNotice(
        created.modelId === "none" || payloadOf(created).insufficientEvidence
          ? "Planning notes created. No model was called because no source excerpt was supplied."
          : `Proposal created with ${created.modelId}${payloadOf(created).repairAttempted ? " after one repair attempt" : ""}. Review it before accepting.`,
      );
    } catch (cause) {
      const requestError = toRequestError(cause);
      // Keep the key when no response arrived, the attempt is still running, or
      // the ledger is temporarily unavailable: retrying may replay a paid reply.
      if (!keepsKeyOnRetry(requestError)) {
        pendingAttempt.current = null;
        clearPendingAttempt(projectId);
      }
      setError(requestError);
    } finally {
      setGenerating(false);
    }
  }

  async function handleAccept() {
    if (!selected || !canAct) return;
    setActing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await acceptPlanningProposal(await getAccessToken(), projectId, selected.id);
      setProposals((current) =>
        (current ?? []).map((proposal) => (proposal.id === result.proposal.id ? result.proposal : proposal)),
      );
      onAccepted(result.project);
      setNotice(
        result.claimsRecorded
          ? `Accepted. The project is now version ${result.project.version}.`
          : `Accepted and saved as version ${result.project.version}, but the claims could not be recorded.`,
      );
    } catch (cause) {
      setError(toRequestError(cause));
    } finally {
      setActing(false);
    }
  }

  async function handleReject() {
    if (!selected || !canAct) return;
    setActing(true);
    setError(null);
    setNotice(null);
    try {
      const rejected = await rejectPlanningProposal(await getAccessToken(), projectId, selected.id);
      setProposals((current) =>
        (current ?? []).map((proposal) => (proposal.id === rejected.id ? rejected : proposal)),
      );
      setNotice("Proposal rejected. The project was not changed.");
    } catch (cause) {
      setError(toRequestError(cause));
    } finally {
      setActing(false);
    }
  }

  return (
    <section className="panel editor-panel" aria-labelledby="planning-heading">
      <div className="panel-heading">
        <h2 id="planning-heading">Plan</h2>
        <span className="status status-dev">One model per task</span>
      </div>
      <p className="muted editor-intro">
        Planning asks one configured model for JSON, validates it independently, and stores it as a proposal. Nothing is
        applied until you accept it; accepting saves a new version, and locked components are never replaced.
      </p>

      <div className="planning-form">
        <label className="field" htmlFor="planning-route">
          <span className="field-label">Task</span>
          <select
            id="planning-route"
            value={route}
            onChange={(event) => setRoute(event.target.value as PlanningRoute)}
            disabled={busy}
          >
            {PLANNING_ROUTES.map((item) => (
              <option key={item} value={item}>
                {PLANNING_ROUTE_LABELS[item]}
              </option>
            ))}
          </select>
          <span className="hint">{PLANNING_ROUTE_HINTS[route]}</span>
        </label>

        <label className="field" htmlFor="planning-instruction">
          <span className="field-label">Instruction (optional)</span>
          <textarea
            id="planning-instruction"
            rows={2}
            maxLength={500}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            disabled={busy}
          />
        </label>

        <div className="editor-actions">
          <button type="button" onClick={() => void handleGenerate()} disabled={busy || dirty}>
            {generating ? "Generating..." : "Generate proposal"}
          </button>
          <p className="hint">
            {dirty
              ? "Save or discard the draft first: planning is generated from the saved version."
              : "Each attempt uses one Idempotency-Key; a retry after a lost response replays it instead of calling the provider again."}
          </p>
        </div>
      </div>

      {error && (
        <div className="alert" role="alert">
          <strong>{error.code}</strong>
          <p>{error.message}</p>
        </div>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      <div className="planning-layout">
        <div className="planning-history">
          <h3>Proposals</h3>
          {!proposals && !error && <p className="muted">Loading proposals...</p>}
          {proposals && proposals.length === 0 && <p className="empty-state">No proposals yet.</p>}
          <ul className="planning-proposals">
            {[...(proposals ?? [])].reverse().map((proposal) => (
              <li key={proposal.id}>
                <button
                  type="button"
                  className={proposal.id === selectedId ? "planning-proposal planning-proposal-active" : "planning-proposal"}
                  onClick={() => setSelectedId(proposal.id)}
                >
                  <span>{proposal.route === "legacy" ? "Recorded" : PLANNING_ROUTE_LABELS[proposal.route as PlanningRoute]}</span>
                  <span className="hint">
                    {statusLabel(proposal.status)} · v{proposal.baseVersion} · {proposal.modelId}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="planning-review">
          {!selected && <p className="empty-state">Select a proposal to review it.</p>}
          {selected && selectedPayload && (
            <article aria-label="Proposal review">
              <div className="panel-heading">
                <h3>
                  {selected.route === "legacy" ? "Recorded proposal" : PLANNING_ROUTE_LABELS[selected.route as PlanningRoute]}
                </h3>
                <span className={selected.status === "accepted" ? "status status-ok" : "status"}>
                  {statusLabel(selected.status)}
                </span>
              </div>
              <p className="hint">
                {selected.modelId} · generated from version {selected.baseVersion} · {new Date(selected.createdAt).toLocaleString()}
              </p>

              {selectedPayload.insufficientEvidence && (
                <div className="alert" role="status">
                  <strong>Planning notes only</strong>
                  <p>No sourced script was produced because no source excerpt was supplied.</p>
                </div>
              )}
              {selectedPayload.repairAttempted && (
                <p className="notice" role="status">
                  The first reply failed validation; this is the single repaired reply.
                </p>
              )}

              <p>{selectedPayload.summary}</p>
              {listOf(selectedPayload.notes).length > 0 && (
                <ul className="planning-list">
                  {listOf(selectedPayload.notes).map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}

              {listOf(selectedPayload.angles).length > 0 && <AngleList angles={listOf(selectedPayload.angles)} />}
              {listOf(selectedPayload.scenes).length > 0 && <ScenarioList scenes={listOf(selectedPayload.scenes)} />}
              {listOf(selectedPayload.clips).length > 0 && <ClipList clips={listOf(selectedPayload.clips)} />}
              {listOf(selectedPayload.claims).length > 0 && (
                <>
                  <h4>Claims</h4>
                  <ClaimList claims={listOf(selectedPayload.claims)} />
                </>
              )}

              {selected.status === "proposed" && (
                <div className="editor-actions">
                  <button type="button" onClick={() => void handleAccept()} disabled={!canAct}>
                    {acting ? "Working..." : "Accept and save"}
                  </button>
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={() => void handleReject()}
                    disabled={!canAct}
                  >
                    Reject
                  </button>
                  <p className="hint">
                    {dirty
                      ? "Save or discard the draft before accepting: accepting writes a new version from the stored one."
                      : `${scenes.length} scene${scenes.length === 1 ? "" : "s"} currently stored; locked components are kept.`}
                  </p>
                </div>
              )}
            </article>
          )}
        </div>
      </div>
    </section>
  );
}
