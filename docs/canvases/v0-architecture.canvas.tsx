import {
  Callout,
  Card,
  CardBody,
  CardHeader,
  Code,
  Divider,
  Grid,
  H1,
  H2,
  H3,
  Pill,
  Row,
  Stack,
  Stat,
  Table,
  Text,
  TodoListCard,
  computeDAGLayout,
  useHostTheme,
  useMemo,
  useState,
} from "cursor/canvas";

const PACKAGES = [
  {
    id: "extension",
    name: "packages/extension",
    role: "VS Code / Cursor",
    status: "radi",
    tone: "success" as const,
    rule: "Sve sto zna za editor: view, komande, webview, CSP.",
    files: [
      ["src/extension.ts", "activate() — registruje view i agent.focus"],
      ["src/chatViewProvider.ts", "HTML + nonce/CSP; prima i salje poruke"],
      ["src/echo.ts", "v0 mozak: vrati isti tekst"],
      ["src/webview/App.tsx", "React chat UI u sidebaru"],
    ],
  },
  {
    id: "shared",
    name: "packages/shared",
    role: "ugovor",
    status: "radi",
    tone: "success" as const,
    rule: "Tipovi poruka. Isti oblik kasnije ide na JSON-RPC (v5).",
    files: [
      ["src/index.ts", "WebviewToExt / ExtToWebview / DiffFile"],
    ],
  },
  {
    id: "agent-core",
    name: "packages/agent-core",
    role: "Mozaik",
    status: "prazan",
    tone: "warning" as const,
    rule: "Bez import vscode. Ovde ide pravi agent loop u v1.",
    files: [
      ["src/index.ts", "placeholder — nema logike"],
    ],
  },
];

const FLOW_LABELS: Record<string, { title: string; sub: string }> = {
  send: { title: "Send", sub: "App.tsx" },
  msg: { title: "user_message", sub: "postMessage" },
  host: { title: "Provider", sub: "ext host" },
  echo: { title: "echo.ts", sub: "isti tekst" },
  delta: { title: "assistant_delta", sub: "pa done" },
};

export default function V0Architecture() {
  const theme = useHostTheme();
  const [pkg, setPkg] = useState("extension");
  const selected = PACKAGES.find((p) => p.id === pkg) ?? PACKAGES[0];

  const layout = useMemo(
    () =>
      computeDAGLayout({
        direction: "horizontal",
        nodeWidth: 118,
        nodeHeight: 48,
        rankGap: 36,
        nodeGap: 16,
        padding: 8,
        nodes: [
          { id: "send" },
          { id: "msg" },
          { id: "host" },
          { id: "echo" },
          { id: "delta" },
        ],
        edges: [
          { from: "send", to: "msg" },
          { from: "msg", to: "host" },
          { from: "host", to: "echo" },
          { from: "echo", to: "delta" },
        ],
      }),
    [],
  );

  return (
    <Stack gap={24}>
      <Stack gap={8}>
        <Row gap={8} align="center">
          <H1>Palm Agent — v0</H1>
          <Pill tone="success" active>
            echo radi
          </Pill>
        </Row>
        <Text tone="secondary">
          Infrastruktura: sidebar chat, poruka ide u extension host i vraca se
          nazad. Nema modela, nema alata, nema apply/diff.
        </Text>
      </Stack>

      <Grid columns={3} gap={12}>
        <Stat value="v0" label="Trenutni milestone" tone="info" />
        <Stat value="3" label="Workspace paketa" />
        <Stat value="echo" label="Odgovor agenta" tone="success" />
      </Grid>

      <Callout tone="info" title="Zasto echo?">
        Cilj v0 je cev, ne inteligencija. Ako Send → host → UI radi, v1 samo
        menja echo.ts pravim Mozaik loop-om u agent-core.
      </Callout>

      <H2>Tok jedne poruke</H2>
      <Text tone="secondary" size="small">
        Linear flow — svaki cvor je jedan skok u kodu.
      </Text>
      <svg
        width="100%"
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label="Tok poruke od Send do assistant_delta"
      >
        {layout.edges.map((edge) => (
          <line
            key={`${edge.from}-${edge.to}`}
            x1={edge.sourceX}
            y1={edge.sourceY}
            x2={edge.targetX}
            y2={edge.targetY}
            stroke={theme.stroke.primary}
            strokeWidth={1.5}
          />
        ))}
        {layout.nodes.map((node) => {
          const label = FLOW_LABELS[node.id];
          const isCore = node.id === "echo";
          return (
            <g key={node.id}>
              <rect
                x={node.x}
                y={node.y}
                width={118}
                height={48}
                rx={4}
                fill={isCore ? theme.fill.tertiary : theme.bg.elevated}
                stroke={isCore ? theme.accent.primary : theme.stroke.secondary}
              />
              <text
                x={node.x + 59}
                y={node.y + 20}
                textAnchor="middle"
                fill={theme.text.primary}
                fontSize={11}
                fontWeight={600}
              >
                {label.title}
              </text>
              <text
                x={node.x + 59}
                y={node.y + 36}
                textAnchor="middle"
                fill={theme.text.tertiary}
                fontSize={10}
              >
                {label.sub}
              </text>
            </g>
          );
        })}
      </svg>
      <Text tone="tertiary" size="small">
        UI zivi u iframe-u (webview). Host je Node proces ekstenzije. Ne dele
        memoriju — samo postMessage JSON.
      </Text>

      <H2>Tri paketa</H2>
      <Text tone="secondary">
        Klikni paket. Pravilo: editor → extension, agent → agent-core, tip
        poruke → shared.
      </Text>
      <Row gap={8} wrap>
        {PACKAGES.map((p) => (
          <span key={p.id}>
            <Pill
              active={pkg === p.id}
              tone={p.tone}
              onClick={() => setPkg(p.id)}
            >
              {p.name}
            </Pill>
          </span>
        ))}
      </Row>
      <Card>
        <CardHeader
          trailing={
            <Pill size="sm" tone={selected.tone} active>
              {selected.status}
            </Pill>
          }
        >
          {selected.name}
        </CardHeader>
        <CardBody>
          <Stack gap={10}>
            <Text>
              Uloga: {selected.role}. {selected.rule}
            </Text>
            <Divider />
            <Table
              headers={["Fajl", "Sta radi"]}
              columnAlign={["left", "left"]}
              rows={selected.files.map(([file, desc]) => [
                <Code>{file}</Code>,
                desc,
              ])}
            />
          </Stack>
        </CardBody>
      </Card>

      <H2>Protokol (vec spreman za v2–v5)</H2>
      <Grid columns={2} gap={16}>
        <Stack gap={8}>
          <H3>webview → host</H3>
          <Table
            headers={["type", "v0"]}
            rows={[
              ["user_message", "radi — echo"],
              ["apply_diff / reject_diff", "tip postoji, niko ne slusa"],
              ["cancel", "tip postoji, niko ne slusa"],
            ]}
            rowTone={["success", "neutral", "neutral"]}
          />
        </Stack>
        <Stack gap={8}>
          <H3>host → webview</H3>
          <Table
            headers={["type", "v0"]}
            rows={[
              ["assistant_delta", "radi — isti tekst"],
              ["done / error", "radi"],
              ["tool_call / diff_proposed", "tip postoji, nije spojen"],
            ]}
            rowTone={["success", "success", "neutral"]}
          />
        </Stack>
      </Grid>

      <H2>Mapa milestone-ova</H2>
      <TodoListCard
        defaultExpanded
        todos={[
          { id: "v0", content: "v0 — F5, sidebar, echo kroz host", status: "completed" },
          { id: "v1", content: "v1 — Mozaik loop + read_file / list_dir / search / get_context", status: "pending" },
          { id: "v2", content: "v2 — propose_edit → vscode.diff → WorkspaceEdit", status: "pending" },
          { id: "v3", content: "v3 — streaming, tool viz, @-context", status: "pending" },
          { id: "v4", content: "v4 — terminal tool iza approval gate-a", status: "pending" },
          { id: "v5", content: "v5 — agent u zasebnom procesu (JSON-RPC)", status: "pending" },
        ]}
      />
    </Stack>
  );
}
