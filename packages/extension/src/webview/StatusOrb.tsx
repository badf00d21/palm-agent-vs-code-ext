/** Uiverse loader (andrew-manzyk/young-walrus-64), MIT — busy toggles hue animation via CSS. */
export function StatusOrb({ busy }: { busy: boolean }) {
  return (
    <div
      className={`status-orb${busy ? " is-busy" : ""}`}
      aria-hidden="true"
    >
      <div className="status-orb-inner">
        <svg width="100" height="100" viewBox="0 0 100 100">
          <defs>
            <mask id="status-orb-clip">
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
        <div className="status-orb-box" />
      </div>
    </div>
  );
}
