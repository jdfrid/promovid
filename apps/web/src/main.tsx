import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { apiGet, apiPost, absoluteAssetUrl } from "./api";
import type { Asset, Project, Provider, RenderJob } from "./types";
import "./styles.css";

type Section = "dashboard" | "create" | "assets" | "settings";

function App() {
  const [section, setSection] = useState<Section>("dashboard");

  return (
    <div className="shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">AdBot MVP</p>
          <h1>סטודיו סרטוני פרסומת</h1>
        </div>
        <nav>
          <button className={section === "dashboard" ? "active" : ""} onClick={() => setSection("dashboard")}>Dashboard</button>
          <button className={section === "create" ? "active" : ""} onClick={() => setSection("create")}>יצירה</button>
          <button className={section === "assets" ? "active" : ""} onClick={() => setSection("assets")}>מאגר חומרים</button>
          <button className={section === "settings" ? "active" : ""} onClick={() => setSection("settings")}>הגדרות</button>
        </nav>
      </aside>
      <main>
        {section === "dashboard" && <Dashboard />}
        {section === "create" && <CreateVideo />}
        {section === "assets" && <Assets />}
        {section === "settings" && <Settings />}
      </main>
    </div>
  );
}

function Dashboard() {
  const [dashboard, setDashboard] = useState<{ stats: Record<string, number>; recentJobs: RenderJob[] }>();
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    void Promise.all([
      apiGet<{ stats: Record<string, number>; recentJobs: RenderJob[] }>("/dashboard").then(setDashboard),
      apiGet<Project[]>("/projects").then(setProjects)
    ]);
  }, []);

  const stats = dashboard?.stats ?? { videosThisWeek: 0, distributed: 0, errors: 0, queued: 0 };

  return (
    <section>
      <div className="page-title">
        <p className="eyebrow">תמונת מצב</p>
        <h2>Dashboard</h2>
      </div>
      <div className="cards">
        <Stat label="סרטונים השבוע" value={stats.videosThisWeek} />
        <Stat label="הושלמו" value={stats.distributed} />
        <Stat label="שגיאות" value={stats.errors} />
        <Stat label="תור המתנה" value={stats.queued} />
      </div>
      <div className="panel">
        <h3>פעולות אחרונות</h3>
        <table>
          <thead>
            <tr>
              <th>סרטון</th>
              <th>סטטוס</th>
              <th>שלב</th>
              <th>התקדמות</th>
              <th>תוצר</th>
            </tr>
          </thead>
          <tbody>
            {dashboard?.recentJobs.map((job) => (
              <tr key={job.id}>
                <td>{job.project?.title}</td>
                <td><Badge value={job.status} /></td>
                <td>{job.stage}</td>
                <td>{job.progress}%</td>
                <td>{job.outputUrl ? <a href={absoluteAssetUrl(job.outputUrl)} target="_blank">צפייה</a> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel">
        <h3>פרויקטים</h3>
        <div className="grid-list">
          {projects.map((project) => (
            <article key={project.id} className="item-card">
              <strong>{project.title}</strong>
              <span>{project.duration} שניות · {project.aspectRatio}</span>
              <Badge value={project.status} />
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function CreateVideo() {
  const [project, setProject] = useState<Project>();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    title: "",
    sourceText: "",
    mode: "manual",
    style: "מודרני, חד, מכירתי",
    targetAudience: "לקוחות חדשים",
    duration: 30,
    aspectRatio: "9:16"
  });

  async function createProject() {
    setBusy(true);
    try {
      setProject(await apiPost<Project>("/projects", form));
    } finally {
      setBusy(false);
    }
  }

  async function renderProject() {
    if (!project) {
      return;
    }
    setBusy(true);
    try {
      await apiPost<RenderJob>(`/projects/${project.id}/render`);
      setProject({ ...project, status: "RENDERING" });
    } finally {
      setBusy(false);
    }
  }

  const steps = ["תסריט", "מדיה", "קול", "הגדרות", "יצירה"];

  return (
    <section>
      <div className="page-title">
        <p className="eyebrow">5 שלבים</p>
        <h2>יצירת סרטון</h2>
      </div>
      <div className="steps">{steps.map((step) => <span key={step}>{step}</span>)}</div>
      <div className="two-col">
        <div className="panel">
          <label>כותרת הסרטון<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
          <label>פריט מידע<textarea value={form.sourceText} onChange={(event) => setForm({ ...form, sourceText: event.target.value })} /></label>
          <label>מצב יצירה<select value={form.mode} onChange={(event) => setForm({ ...form, mode: event.target.value })}>
            <option value="manual">ידני</option>
            <option value="automatic">אוטומטי</option>
            <option value="assisted">חצי-אוטומטי</option>
            <option value="series">סדרה</option>
          </select></label>
          <label>סגנון<input value={form.style} onChange={(event) => setForm({ ...form, style: event.target.value })} /></label>
          <label>קהל יעד<input value={form.targetAudience} onChange={(event) => setForm({ ...form, targetAudience: event.target.value })} /></label>
          <div className="row">
            <label>אורך<select value={form.duration} onChange={(event) => setForm({ ...form, duration: Number(event.target.value) })}>
              {[15, 30, 45, 60].map((duration) => <option key={duration} value={duration}>{duration}</option>)}
            </select></label>
            <label>יחס תצוגה<select value={form.aspectRatio} onChange={(event) => setForm({ ...form, aspectRatio: event.target.value })}>
              <option>9:16</option>
              <option>16:9</option>
              <option>1:1</option>
            </select></label>
          </div>
          <button className="primary" disabled={busy || !form.title || !form.sourceText} onClick={createProject}>יצירת תסריט</button>
        </div>
        <div className="panel">
          <h3>תסריט וסצנות</h3>
          {!project && <p className="muted">לאחר יצירת התסריט יוצגו כאן סצנות של 7-8 שניות.</p>}
          {project?.scenes.map((scene) => (
            <article key={scene.id} className="scene">
              <strong>{scene.title}</strong>
              <p>{scene.narration}</p>
              <small>{scene.visualPrompt} · {scene.durationSeconds}s</small>
            </article>
          ))}
          {project && <button className="primary" disabled={busy} onClick={renderProject}>שליחה לרינדור</button>}
        </div>
      </div>
    </section>
  );
}

function Assets() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [file, setFile] = useState<File>();
  const [type, setType] = useState("IMAGE");

  async function refresh() {
    setAssets(await apiGet<Asset[]>("/assets"));
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function upload() {
    if (!file) {
      return;
    }
    const form = new FormData();
    form.append("file", file);
    form.append("type", type);
    form.append("name", file.name);
    await apiPost<Asset>("/assets", form);
    setFile(undefined);
    await refresh();
  }

  return (
    <section>
      <div className="page-title">
        <p className="eyebrow">Assets</p>
        <h2>מאגר חומרים</h2>
      </div>
      <div className="panel upload">
        <select value={type} onChange={(event) => setType(event.target.value)}>
          <option value="IMAGE">תמונה</option>
          <option value="VIDEO">וידאו</option>
          <option value="VOICE">קול</option>
          <option value="MUSIC">מוסיקה</option>
          <option value="AVATAR">אווטר</option>
          <option value="SCRIPT">תסריט</option>
        </select>
        <input type="file" onChange={(event) => setFile(event.target.files?.[0])} />
        <button className="primary" onClick={upload}>העלאה</button>
      </div>
      <div className="asset-grid">
        {assets.map((asset) => (
          <article key={asset.id} className="item-card">
            <strong>{asset.name}</strong>
            <span>{asset.type}</span>
            <a href={absoluteAssetUrl(asset.url)} target="_blank">פתיחה</a>
          </article>
        ))}
      </div>
    </section>
  );
}

function Settings() {
  const [providers, setProviders] = useState<Provider[]>([]);

  useEffect(() => {
    void apiGet<Provider[]>("/providers").then(setProviders);
  }, []);

  const grouped = useMemo(() => {
    return providers.reduce<Record<string, Provider[]>>((acc, provider) => {
      acc[provider.type] = [...(acc[provider.type] ?? []), provider];
      return acc;
    }, {});
  }, [providers]);

  return (
    <section>
      <div className="page-title">
        <p className="eyebrow">Providers</p>
        <h2>הגדרות ספקים</h2>
      </div>
      <div className="provider-grid">
        {Object.entries(grouped).map(([type, items]) => (
          <article className="panel" key={type}>
            <h3>{type}</h3>
            {items?.map((provider) => (
              <div className="provider" key={provider.id}>
                <strong>{provider.displayName}</strong>
                <span>{provider.provider} · priority {provider.priority}</span>
                <Badge value={provider.enabled ? "enabled" : "disabled"} />
              </div>
            ))}
          </article>
        ))}
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <article className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function Badge({ value }: { value: string }) {
  return <span className={`badge ${value.toLowerCase()}`}>{value}</span>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
