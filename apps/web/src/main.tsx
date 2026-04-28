import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { apiGet, apiPatch, apiPost, absoluteAssetUrl } from "./api";
import type { Asset, Project, Provider, RenderJob } from "./types";
import "./styles.css";

type Section = "dashboard" | "create" | "assets" | "settings";

interface OperationLog {
  at: string;
  step: string;
  message: string;
  metadata?: Record<string, unknown>;
}

const defaultCreateForm = {
  title: "",
  sourceText: "",
  mode: "manual",
  style: "מודרני, חד, מכירתי",
  targetAudience: "לקוחות חדשים",
  duration: 30,
  aspectRatio: "9:16"
};

type CreateForm = typeof defaultCreateForm;

function loadCreateForm(): CreateForm {
  try {
    const saved = localStorage.getItem("promovid:create-form");
    return saved ? { ...defaultCreateForm, ...JSON.parse(saved) } : defaultCreateForm;
  } catch {
    return defaultCreateForm;
  }
}

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
  const [error, setError] = useState("");
  const [actionLogs, setActionLogs] = useState<OperationLog[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("promovid:create-logs") ?? "[]") as OperationLog[];
    } catch {
      return [];
    }
  });
  const [form, setForm] = useState<CreateForm>(() => loadCreateForm());

  useEffect(() => {
    localStorage.setItem("promovid:create-form", JSON.stringify(form));
  }, [form]);

  useEffect(() => {
    localStorage.setItem("promovid:create-logs", JSON.stringify(actionLogs.slice(0, 80)));
  }, [actionLogs]);

  function addLog(step: string, message: string, metadata?: Record<string, unknown>) {
    setActionLogs((current) => [
      { at: new Date().toISOString(), step, message, metadata },
      ...current
    ].slice(0, 80));
  }

  function updateForm<Key extends keyof typeof form>(key: Key, value: (typeof form)[Key]) {
    setForm((current) => ({ ...current, [key]: value }));
    addLog("form_updated", `עודכן השדה ${String(key)}`, { field: key, value: key === "sourceText" ? `${String(value).slice(0, 140)}...` : value });
  }

  async function createProject() {
    setBusy(true);
    setError("");
    addLog("create_script_clicked", "נלחץ כפתור יצירת תסריט", {
      title: form.title,
      duration: form.duration,
      aspectRatio: form.aspectRatio,
      sourceLength: form.sourceText.length
    });
    try {
      addLog("create_script_request_sent", "שולח את הערכים לשרת");
      const createdProject = await apiPost<Project & { operationLogs?: OperationLog[] }>("/projects", form);
      setProject(createdProject);
      addLog("create_script_response_received", "התקבלה תשובה מהשרת", {
        projectId: createdProject.id,
        sceneCount: createdProject.scenes.length
      });
      if (createdProject.operationLogs?.length) {
        setActionLogs((current) => [...createdProject.operationLogs!.reverse(), ...current].slice(0, 80));
      }
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "יצירת התסריט נכשלה";
      setError(message);
      addLog("create_script_failed", "יצירת התסריט נכשלה", { error: message });
    } finally {
      setBusy(false);
    }
  }

  async function renderProject() {
    if (!project) {
      return;
    }
    setBusy(true);
    setError("");
    addLog("render_request_sent", "שולח את הפרויקט לרינדור", { projectId: project.id });
    try {
      await apiPost<RenderJob>(`/projects/${project.id}/render`);
      setProject({ ...project, status: "RENDERING" });
      addLog("render_request_queued", "הרינדור נכנס לתור", { projectId: project.id });
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "שליחה לרינדור נכשלה";
      setError(message);
      addLog("render_request_failed", "שליחה לרינדור נכשלה", { error: message });
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
          <label>כותרת הסרטון<input value={form.title} onChange={(event) => updateForm("title", event.target.value)} /></label>
          <label>פריט מידע, קישור והוראות
            <textarea
              value={form.sourceText}
              placeholder={"אפשר להדביק URL והוראות, לדוגמה:\nhttps://example.com/product\nתכין סרטון פרסומת למוצר הזה"}
              onChange={(event) => updateForm("sourceText", event.target.value)}
            />
          </label>
          <label>מצב יצירה<select value={form.mode} onChange={(event) => updateForm("mode", event.target.value)}>
            <option value="manual">ידני</option>
            <option value="automatic">אוטומטי</option>
            <option value="assisted">חצי-אוטומטי</option>
            <option value="series">סדרה</option>
          </select></label>
          <label>סגנון<input value={form.style} onChange={(event) => updateForm("style", event.target.value)} /></label>
          <label>קהל יעד<input value={form.targetAudience} onChange={(event) => updateForm("targetAudience", event.target.value)} /></label>
          <div className="row">
            <label>אורך<select value={form.duration} onChange={(event) => updateForm("duration", Number(event.target.value))}>
              {[15, 30, 45, 60].map((duration) => <option key={duration} value={duration}>{duration}</option>)}
            </select></label>
            <label>יחס תצוגה<select value={form.aspectRatio} onChange={(event) => updateForm("aspectRatio", event.target.value)}>
              <option>9:16</option>
              <option>16:9</option>
              <option>1:1</option>
            </select></label>
          </div>
          <button className="primary" disabled={busy || !form.title || !form.sourceText} onClick={createProject}>{busy ? "מעבד..." : "יצירת תסריט"}</button>
          {error && <p className="notice error-notice">{error}</p>}
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
      <div className="panel">
        <div className="log-header">
          <h3>לוג פעולות</h3>
          <button className="secondary" onClick={() => setActionLogs([])}>ניקוי לוג</button>
        </div>
        {actionLogs.length === 0 && <p className="muted">הלוג יופיע כאן מרגע הזנת הערכים ושליחת התסריט.</p>}
        <div className="operation-log">
          {actionLogs.map((log, index) => (
            <article key={`${log.at}-${index}`}>
              <strong>{log.message}</strong>
              <span>{new Date(log.at).toLocaleTimeString("he-IL")} · {log.step}</span>
              {log.metadata && <code>{JSON.stringify(log.metadata)}</code>}
            </article>
          ))}
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

const providerServiceTypes = [
  { type: "SCRIPT", label: "תסריט", description: "מודלי AI לכתיבת תסריטים וחלוקה לסצנות.", presets: [["gemini", "Gemini Script Writer"], ["openai", "OpenAI Script Writer"], ["anthropic", "Claude Script Writer"]] },
  { type: "MEDIA", label: "מדיה", description: "חיפוש ושליפת תמונות ווידאו ממאגרים.", presets: [["pexels", "Pexels Media Search"], ["shutterstock", "Shutterstock"], ["unsplash", "Unsplash"]] },
  { type: "VOICE", label: "קול", description: "TTS וקריינות לסרטונים.", presets: [["elevenlabs", "ElevenLabs Voiceover"], ["murf", "Murf Voice"], ["playht", "Play.ht Voice"]] },
  { type: "MUSIC", label: "מוסיקה", description: "מוסיקת רקע וספריות סאונד.", presets: [["epidemic", "Epidemic Sound"], ["artlist", "Artlist"]] },
  { type: "AVATAR", label: "אווטרים", description: "יצירת דמויות/דוברים וירטואליים.", presets: [["heygen", "HeyGen"], ["did", "D-ID"], ["synthesia", "Synthesia"]] },
  { type: "VIDEO", label: "יצירת וידאו", description: "מחוללי וידאו AI ליצירת קליפים לכל סצנה.", presets: [["runway", "Runway"], ["kling", "Kling AI"], ["gemini", "Gemini Video"]] },
  { type: "MERGE", label: "מיזוג", description: "חיבור סצנות, כתוביות, watermark ו־transitions.", presets: [["ffmpeg", "Self-hosted FFmpeg"], ["shotstack", "Shotstack"], ["creatomate", "Creatomate"]] },
  { type: "STORAGE", label: "אחסון", description: "שמירת קבצים ותוצרים סופיים.", presets: [["local", "Local Storage"], ["cloudflare-r2", "Cloudflare R2"], ["s3", "AWS S3"], ["cloudinary", "Cloudinary"]] },
  { type: "DISTRIBUTION", label: "הפצה", description: "פרסום לרשתות, webhooks וערוצי יציאה.", presets: [["youtube", "YouTube"], ["instagram", "Instagram"], ["tiktok", "TikTok"], ["linkedin", "LinkedIn"]] }
] as const;

function Settings() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [activeType, setActiveType] = useState(() => localStorage.getItem("promovid:settings-active-type") ?? "SCRIPT");
  const [selectedId, setSelectedId] = useState<string>("new");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    type: "SCRIPT",
    provider: "gemini",
    displayName: "Gemini Script Writer",
    apiKey: "",
    priority: 1,
    enabled: true,
    model: "gemini-1.5-flash",
    temperature: 0.7
  });
  useEffect(() => {
    void apiGet<Provider[]>("/providers").then(setProviders);
  }, []);

  useEffect(() => {
    localStorage.setItem("promovid:settings-active-type", activeType);
  }, [activeType]);

  const activeService = providerServiceTypes.find((service) => service.type === activeType) ?? providerServiceTypes[0];
  const activeProviders = useMemo(() => providers.filter((provider) => provider.type === activeType), [activeType, providers]);

  function refreshProviders() {
    return apiGet<Provider[]>("/providers").then(setProviders);
  }

  function selectProvider(providerId: string) {
    setSelectedId(providerId);
    setMessage("");

    if (providerId === "new") {
      setForm({
        type: activeType,
        provider: activeService.presets[0]?.[0] ?? "",
        displayName: activeService.presets[0]?.[1] ?? "",
        apiKey: "",
        priority: 1,
        enabled: true,
        model: "gemini-1.5-flash",
        temperature: 0.7
      });
      return;
    }

    const provider = providers.find((item) => item.id === providerId);
    if (provider) {
      setActiveType(provider.type);
      setForm({
        type: provider.type,
        provider: provider.provider,
        displayName: provider.displayName,
        apiKey: "",
        priority: provider.priority,
        enabled: provider.enabled,
        model: typeof provider.config?.model === "string" ? provider.config.model : "gemini-1.5-flash",
        temperature: Number(provider.config?.temperature ?? 0.7)
      });
    }
  }

  async function saveProvider() {
    setSaving(true);
    setMessage("");
    try {
      const payload = {
        ...form,
        type: activeType,
        priority: Number(form.priority),
        apiKey: form.apiKey.trim() || undefined,
        config: activeType === "SCRIPT"
          ? {
              model: form.model.trim() || "gemini-1.5-flash",
              temperature: Number(form.temperature)
            }
          : {}
      };

      if (selectedId === "new") {
        await apiPost<Provider>("/providers", payload);
      } else {
        await apiPatch<Provider>(`/providers/${selectedId}`, payload);
      }

      await refreshProviders();
      setForm((current) => ({ ...current, apiKey: "" }));
      setMessage("ההגדרות נשמרו. המפתח מוצפן ולא יוצג שוב במסך.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "שמירה נכשלה");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <div className="page-title">
        <p className="eyebrow">Providers</p>
        <h2>הגדרות ספקים</h2>
      </div>
      <div className="service-tabs">
        {providerServiceTypes.map((service) => (
          <button
            className={activeType === service.type ? "active" : ""}
            key={service.type}
            onClick={() => {
              setActiveType(service.type);
              setSelectedId("new");
              setMessage("");
              setForm({
                type: service.type,
                provider: service.presets[0]?.[0] ?? "",
                displayName: service.presets[0]?.[1] ?? "",
                apiKey: "",
                priority: 1,
                enabled: true,
                model: "gemini-1.5-flash",
                temperature: 0.7
              });
            }}
          >
            {service.label}
          </button>
        ))}
      </div>
      <div className="service-heading panel">
        <div>
          <p className="eyebrow">{activeService.type}</p>
          <h3>{activeService.label}</h3>
          <p className="muted">{activeService.description}</p>
        </div>
        <Badge value={`${activeProviders.length} providers`} />
      </div>
      <div className="two-col">
        <div className="panel">
          <h3>הגדרת ספק עבור {activeService.label}</h3>
          <label>בחירת ספק
            <select value={selectedId} onChange={(event) => selectProvider(event.target.value)}>
              <option value="new">ספק חדש</option>
              {activeProviders.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.displayName} ({provider.type})
                </option>
              ))}
            </select>
          </label>
          <div className="readonly-service">סוג שירות: {activeService.label}</div>
          <label>מזהה ספק
            <input value={form.provider} placeholder="openai / pexels / elevenlabs" onChange={(event) => setForm({ ...form, provider: event.target.value })} />
          </label>
          <label>שם לתצוגה
            <input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} />
          </label>
          <label>API Key
            <input type="password" value={form.apiKey} placeholder="הדבק כאן מפתח חדש. להשאיר ריק כדי לא לשנות." onChange={(event) => setForm({ ...form, apiKey: event.target.value })} />
          </label>
          {activeType === "SCRIPT" && (
            <div className="row">
              <label>מודל
                <input value={form.model} placeholder="gemini-1.5-flash / gemini-2.0-flash" onChange={(event) => setForm({ ...form, model: event.target.value })} />
              </label>
              <label>Temperature
                <input type="number" min="0" max="2" step="0.1" value={form.temperature} onChange={(event) => setForm({ ...form, temperature: Number(event.target.value) })} />
              </label>
            </div>
          )}
          <div className="row compact-row">
            <label>עדיפות
              <input type="number" min="1" value={form.priority} onChange={(event) => setForm({ ...form, priority: Number(event.target.value) })} />
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />
              פעיל
            </label>
          </div>
          <button className="primary" disabled={saving || !form.provider || !form.displayName} onClick={saveProvider}>
            {saving ? "שומר..." : "שמירת הגדרות"}
          </button>
          {message && <p className="notice">{message}</p>}
        </div>
        <div className="panel">
          <h3>ספקים מומלצים עבור {activeService.label}</h3>
          <div className="quick-presets">
            {activeService.presets.map(([provider, displayName]) => (
              <button key={`${activeType}-${provider}`} onClick={() => {
                setSelectedId("new");
                setForm({ type: activeType, provider, displayName, apiKey: "", priority: 1, enabled: true, model: provider === "gemini" ? "gemini-1.5-flash" : "", temperature: 0.7 });
              }}>
                {displayName}
              </button>
            ))}
          </div>
          <p className="muted">המפתחות נשמרים מוצפנים בצד השרת. לאחר שמירה לא ניתן לראות את הערך המקורי, רק להחליף אותו.</p>
        </div>
      </div>
      <div className="provider-grid">
          <article className="panel">
            <h3>ספקים מוגדרים עבור {activeService.label}</h3>
            {activeProviders.length === 0 && <p className="muted">עדיין לא הוגדרו ספקים לסוג השירות הזה.</p>}
            {activeProviders.map((provider) => (
              <div className="provider" key={provider.id}>
                <strong>{provider.displayName}</strong>
                <span>{provider.provider} · priority {provider.priority} · key {provider.hasSecret ? "saved" : "missing"}</span>
                <Badge value={provider.enabled ? "enabled" : "disabled"} />
                <button className="secondary" onClick={() => selectProvider(provider.id)}>עריכה</button>
              </div>
            ))}
          </article>
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
