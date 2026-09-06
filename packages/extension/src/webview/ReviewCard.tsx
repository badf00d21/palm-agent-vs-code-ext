import { useState } from "react";
import type { WebviewToExt } from "@palm-agent/shared";
import type { ReviewLine } from "./chatMessages";

export interface ReviewCardProps {
  message: ReviewLine;
  postMessage: (msg: WebviewToExt) => void;
}

export function ReviewCard({ message, postMessage }: ReviewCardProps) {
  const [open, setOpen] = useState(message.status === "pending");
  const pending = message.status === "pending";
  const fileLabel = `${message.files.length} file${message.files.length === 1 ? "" : "s"}`;
  const statusText =
    message.status === "kept" ? "Kept" : message.status === "undone" ? "Undone" : undefined;
  const filesId = `review-files-${message.id}`;
  const hasReviewable = message.files.some((file) => file.kind !== "mkdir");

  return (
    <>
      <div className="review-head">
        <button
          type="button"
          className="btn btn-ghost review-toggle"
          aria-expanded={open}
          aria-controls={open ? filesId : undefined}
          aria-label={statusText ? `${fileLabel}, ${statusText}` : `${fileLabel}, pending review`}
          onClick={() => setOpen((value) => !value)}
        >
          {fileLabel}
        </button>
        {statusText ? <span className="review-status">{statusText}</span> : null}
      </div>
      {open ? (
        <div id={filesId}>
          <ul className="review-list">
            {message.files.map((file) => {
              const isDelete = file.kind === "delete";
              const fileClassName = isDelete ? "review-file review-file-delete" : "review-file";
              const kindLabel =
                file.kind === "create" ? "new" : isDelete ? "delete" : null;
              const kindClassName = isDelete ? "review-kind review-kind-delete" : "review-kind";
              return (
                <li key={file.path}>
                  {pending && file.kind !== "mkdir" ? (
                    <button
                      type="button"
                      className={`btn btn-ghost ${fileClassName}`}
                      onClick={() => postMessage({ type: "open_diff", id: message.id, path: file.path })}
                    >
                      {file.path}
                      {kindLabel ? <span className={kindClassName}> {kindLabel}</span> : null}
                    </button>
                  ) : (
                    <span
                      className={
                        pending
                          ? isDelete
                            ? "review-file-delete"
                            : undefined
                          : `review-file-static${isDelete ? " review-file-delete" : ""}`
                      }
                    >
                      {file.path}
                      {kindLabel ? <span className={kindClassName}> {kindLabel}</span> : null}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {pending ? (
            <div className="review-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => postMessage({ type: "reject_diff", id: message.id })}
              >
                Undo All
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => postMessage({ type: "apply_diff", id: message.id })}
              >
                Keep All
              </button>
              {hasReviewable ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => postMessage({ type: "open_diff", id: message.id })}
                >
                  Review
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
