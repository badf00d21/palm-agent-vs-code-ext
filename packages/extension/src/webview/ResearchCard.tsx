import { useState } from "react";
import type { ResearchWorker, ResearchWorkerStatus, WebviewToExt } from "@palm-agent/shared";
import type { ResearchLine } from "./chatMessages";
import { AssistantMarkdown } from "./markdown";

export interface ResearchCardProps {
  message: ResearchLine;
  postMessage: (msg: WebviewToExt) => void;
}

const STATUS_LABEL: Record<ResearchWorkerStatus, string> = {
  pending: "Pending",
  running: "Running",
  done: "Done",
  failed: "Failed",
};

function WorkerRow({ worker }: { worker: ResearchWorker }) {
  const [open, setOpen] = useState(false);
  const detail = worker.status === "failed" ? worker.error : worker.finding;
  const hasDetail = Boolean(detail);
  const detailId = `research-worker-detail-${worker.id}`;
  const meta = [
    worker.status === "running" && worker.activity ? worker.activity : STATUS_LABEL[worker.status],
    worker.steps > 0 ? `${worker.steps} step${worker.steps === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className={`research-worker research-worker-${worker.status}`}>
      <button
        type="button"
        className="research-worker-head"
        aria-expanded={hasDetail ? open : undefined}
        aria-controls={hasDetail ? detailId : undefined}
        onClick={() => setOpen((value) => !value)}
        disabled={!hasDetail}
      >
        <span
          className={`research-status-dot research-status-${worker.status}`}
          aria-hidden="true"
        />
        <span className="research-worker-question">{worker.question}</span>
        <span className="research-worker-meta">{meta}</span>
      </button>
      {hasDetail && open ? (
        <p
          id={detailId}
          className={`research-worker-detail${worker.status === "failed" ? " research-worker-error" : ""}`}
        >
          {detail}
        </p>
      ) : null}
    </li>
  );
}

export function ResearchCard({ message, postMessage }: ResearchCardProps) {
  const [digestOpen, setDigestOpen] = useState(false);
  const counts = message.workers.reduce<Record<ResearchWorkerStatus, number>>(
    (acc, worker) => {
      acc[worker.status] += 1;
      return acc;
    },
    { pending: 0, running: 0, done: 0, failed: 0 },
  );
  const summary = [
    `${counts.done} done`,
    counts.failed ? `${counts.failed} failed` : null,
    counts.running ? `${counts.running} running` : null,
    counts.pending ? `${counts.pending} pending` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className={`research-card research-card-${message.status}`}>
      <p className="research-question">{message.question}</p>
      <p className="research-summary">
        {summary} of {message.workers.length}
      </p>
      <ul className="research-workers">
        {message.workers.map((worker) => (
          <WorkerRow key={worker.id} worker={worker} />
        ))}
      </ul>
      {message.status === "cancelled" ? (
        <p className="research-terminal research-terminal-cancelled">
          Research cancelled{message.message ? ` — ${message.message}` : ""}
        </p>
      ) : null}
      {message.status === "failed" ? (
        <p className="research-terminal research-terminal-failed">
          {message.message ?? "Research failed"}
        </p>
      ) : null}
      {message.status === "done" && message.digest ? (
        <>
          <button
            type="button"
            className="btn btn-ghost research-digest-toggle"
            aria-expanded={digestOpen}
            onClick={() => setDigestOpen((value) => !value)}
          >
            {digestOpen ? "Hide digest" : "Show digest"}
          </button>
          {digestOpen ? (
            <div className="research-digest">
              <AssistantMarkdown
                text={message.digest}
                onOpenUrl={(url) => postMessage({ type: "open_url", url })}
                onOpenLocation={(path, line) => postMessage({ type: "open_location", path, line })}
              />
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
