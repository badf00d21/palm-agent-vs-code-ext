import { useId } from "react";

/** Uiverse loader (andrew-manzyk/young-walrus-64), MIT — busy toggles hue animation via CSS. */
export function StatusOrb({
  busy,
  title,
}: {
  busy: boolean;
  /** Native tooltip / accessible name (e.g. research worker sub-question). */
  title?: string;
}) {
  const reactId = useId().replace(/:/g, "");
  const maskId = `status-orb-clip-${reactId}`;

  return (
    <div
      className={`status-orb${busy ? " is-busy" : ""}`}
      title={title}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      role={title ? "img" : undefined}
    >
      <div className="status-orb-inner">
        <svg width="100" height="100" viewBox="0 0 100 100">
          <defs>
            <mask id={maskId} className="status-orb-mask">
              <polygon points="0,0 100,0 100,100 0,100" fill="black" />
              <polygon points="25,25 75,25 50,75" fill="white" />
              <polygon points="50,25 75,75 25,75" fill="white" />
              <polygon points="35,35 65,35 50,65" fill="white" />
              <polygon points="35,35 65,35 50,65" fill="white" />
              <polygon points="35,35 65,35 50,65" fill="white" />
              <polygon points="35,35 65,35 50,65" fill="white" />
            </mask>
          </defs>
        </svg>
        <div className="status-orb-box" style={{ mask: `url(#${maskId})`, WebkitMask: `url(#${maskId})` }} />
      </div>
    </div>
  );
}
