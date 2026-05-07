import { Component, StrictMode, useEffect, useMemo, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { apiGet, apiPatch, apiPost, absoluteAssetUrl } from "./api";
import type { Asset, AuditLog, Project, Provider, RenderJob } from "./types";
import "./styles.css";

type Section = "dashboard" | "preproduction" | "renderStudio" | "assets" | "settings";

class AppErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("AdBot frontend crashed", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="boot-error">
          <h1>שגיאת טעינת ממשק</h1>
          <p>{this.state.error.message}</p>
          <button onClick={() => window.location.reload()}>טעינה מחדש</button>
        </div>
      );
    }

    return this.props.children;
  }
}

interface OperationLog {
  at: string;
  step: string;
  message: string;
  metadata?: Record<string, unknown>;
}

const defaultCreateForm = {
  title: "",
  sourceText: "",
  supplementalLinksText: "",
  mode: "manual",
  style: "מודרני, חד, מכירתי",
  targetAudience: "לקוחות חדשים",
  duration: 30,
  aspectRatio: "9:16"
};

type CreateForm = typeof defaultCreateForm;

interface SupplementalFileInput {
  name: string;
  mimeType?: string;
  assetType?: string;
  assetUrl?: string;
  extractedText?: string;
  imageDataUrl?: string;
}

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
  const [selectedProjectId, setSelectedProjectId] = useState<string>();

  function openProject(projectId: string) {
    setSelectedProjectId(projectId);
    setSection("preproduction");
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">AdBot MVP</p>
          <h1>סטודיו סרטוני פרסומת</h1>
        </div>
        <nav>
          <button className={section === "dashboard" ? "active" : ""} onClick={() => setSection("dashboard")}>Dashboard</button>
          <button className={section === "preproduction" ? "active" : ""} onClick={() => {
            setSelectedProjectId(undefined);
            setSection("preproduction");
          }}>Pre‑Production</button>
          <button className={section === "renderStudio" ? "active" : ""} onClick={() => setSection("renderStudio")}>Render Studio</button>
          <button className={section === "assets" ? "active" : ""} onClick={() => setSection("assets")}>מאגר חומרים</button>
          <button className={section === "settings" ? "active" : ""} onClick={() => setSection("settings")}>הגדרות</button>
        </nav>
      </aside>
      <main>
        {section === "dashboard" && <Dashboard onOpenProject={openProject} />}
        {section === "preproduction" && <CreateVideo selectedProjectId={selectedProjectId} />}
        {section === "renderStudio" && <RenderStudio />}
        {section === "assets" && <Assets />}
        {section === "settings" && <Settings />}
      </main>
    </div>
  );
}

function Dashboard({ onOpenProject }: { onOpenProject: (projectId: string) => void }) {
  const [dashboard, setDashboard] = useState<{ stats: Record<string, number>; recentJobs: RenderJob[] }>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    void Promise.all([
      apiGet<{ stats: Record<string, number>; recentJobs: RenderJob[] }>("/dashboard").then(setDashboard),
      apiGet<Project[]>("/projects").then(setProjects)
    ]).catch((error: unknown) => {
      setLoadError(error instanceof Error ? error.message : "טעינת Dashboard נכשלה");
    });
  }, []);

  const stats = dashboard?.stats ?? { videosThisWeek: 0, distributed: 0, errors: 0, queued: 0 };

  return (
    <section>
      <div className="page-title">
        <p className="eyebrow">תמונת מצב</p>
        <h2>Dashboard</h2>
      </div>
      {loadError && <p className="notice error-notice">{loadError}</p>}
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
                <td>
                  {job.project ? (
                    <button className="link-button" onClick={() => onOpenProject(job.project!.id)}>{job.project.title}</button>
                  ) : "—"}
                </td>
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
              <button className="secondary" onClick={() => onOpenProject(project.id)}>פתיחת פרויקט</button>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function CreateVideo({ selectedProjectId }: { selectedProjectId?: string }) {
  const [project, setProject] = useState<Project>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [diagnosticMessage, setDiagnosticMessage] = useState("");
  const [renderLogs, setRenderLogs] = useState<AuditLog[]>([]);
  const [actionLogs, setActionLogs] = useState<OperationLog[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("promovid:create-logs") ?? "[]") as OperationLog[];
    } catch {
      return [];
    }
  });
  const [form, setForm] = useState<CreateForm>(() => loadCreateForm());
  const [supplementalFiles, setSupplementalFiles] = useState<File[]>([]);

  useEffect(() => {
    localStorage.setItem("promovid:create-form", JSON.stringify(form));
  }, [form]);

  useEffect(() => {
    localStorage.setItem("promovid:create-logs", JSON.stringify(actionLogs.slice(0, 80)));
  }, [actionLogs]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }

    void loadProject(selectedProjectId);
  }, [selectedProjectId]);

  useEffect(() => {
    if (!project || project.status !== "RENDERING") {
      return undefined;
    }

    const interval = window.setInterval(() => {
      void refreshProject(project.id);
    }, 5000);
    return () => window.clearInterval(interval);
  }, [project]);

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
      sourceLength: form.sourceText.length,
      supplementalLinkCount: splitSupplementalLinks(form.supplementalLinksText).length,
      supplementalFileCount: supplementalFiles.length
    });
    try {
      const uploadedFiles = await uploadSupplementalFiles(supplementalFiles);
      addLog("create_script_request_sent", "שולח את הערכים לשרת");
      const createdProject = await apiPost<Project & { operationLogs?: OperationLog[] }>("/projects", {
        ...form,
        supplementalLinks: splitSupplementalLinks(form.supplementalLinksText),
        supplementalFiles: uploadedFiles
      });
      setProject(createdProject);
      addLog("create_script_response_received", "התקבלה תשובה מהשרת", {
        projectId: createdProject.id,
        sceneCount: createdProject.scenes.length
      });
      setSupplementalFiles([]);
      addLog("script_ready_waiting_for_render", "התסריט מוכן. כדי לאסוף מדיה, מוסיקה וליצור וידאו צריך ללחוץ שליחה לרינדור.", {
        projectId: createdProject.id,
        nextAction: "analyze_script"
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

  async function uploadSupplementalFiles(files: File[]): Promise<SupplementalFileInput[]> {
    const uploaded: SupplementalFileInput[] = [];
    for (const file of files.slice(0, 8)) {
      addLog("supplemental_file_upload_started", "מעלה קובץ/תמונה ל-Pre-Production", {
        name: file.name,
        mimeType: file.type,
        size: file.size
      });
      const assetType = inferAssetType(file);
      const formData = new FormData();
      formData.append("file", file);
      formData.append("type", assetType);
      formData.append("name", file.name);
      const [asset, context] = await Promise.all([
        apiPost<Asset>("/assets", formData),
        readFileForScriptContext(file)
      ]);
      uploaded.push({
        name: file.name,
        mimeType: file.type || asset.mimeType,
        assetType,
        assetUrl: asset.url,
        ...context
      });
      addLog("supplemental_file_upload_completed", "הקובץ נשמר ויצורף כהקשר לתסריט", {
        name: file.name,
        assetId: asset.id,
        assetType,
        hasExtractedText: Boolean(context.extractedText),
        hasImageReference: Boolean(context.imageDataUrl)
      });
    }
    return uploaded;
  }

  async function runProjectStage(path: string, startedStep: string, startedMessage: string, completedStep: string, completedMessage: string) {
    if (!project) {
      return;
    }
    setBusy(true);
    setError("");
    addLog(startedStep, startedMessage, { projectId: project.id });
    try {
      const updatedProject = await apiPost<Project & { operationLogs?: OperationLog[] }>(`/projects/${project.id}/${path}`);
      setProject(updatedProject);
      addLog(completedStep, completedMessage, { projectId: updatedProject.id, status: updatedProject.status });
      if (updatedProject.operationLogs?.length) {
        setActionLogs((current) => [...updatedProject.operationLogs!.reverse(), ...current].slice(0, 80));
      }
      await refreshProject(updatedProject.id);
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "הפעולה נכשלה";
      setError(message);
      addLog(`${startedStep}_failed`, "הפעולה נכשלה", { error: message });
    } finally {
      setBusy(false);
    }
  }

  function analyzeProject() {
    return runProjectStage(
      "analyze-script",
      "script_analysis_clicked",
      "נלחץ כפתור ניתוח תסריט חכם",
      "script_analysis_ready",
      "ניתוח התסריט מוכן"
    );
  }

  function collectAssets() {
    return runProjectStage(
      "collect-assets",
      "collect_assets_clicked",
      "נלחץ כפתור איסוף חומרים",
      "assets_ready",
      "ספריית החומרים מוכנה"
    );
  }

  function buildRenderPackage() {
    return runProjectStage(
      "render-package",
      "render_package_clicked",
      "נלחץ כפתור בניית חבילת רינדור",
      "render_package_ready",
      "חבילת הרינדור מוכנה לאישור"
    );
  }

  function approveRenderPackage() {
    return runProjectStage(
      "approve-render-package",
      "approve_render_package_clicked",
      "נלחץ כפתור אישור מעבר לרינדור",
      "render_package_approved",
      "חבילת הרינדור אושרה"
    );
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
      await refreshProject(project.id);
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "שליחה לרינדור נכשלה";
      setError(message);
      addLog("render_request_failed", "שליחה לרינדור נכשלה", { error: message });
    } finally {
      setBusy(false);
    }
  }

  async function refreshProject(projectId: string) {
    const [projects, logs] = await Promise.all([
      apiGet<Project[]>("/projects"),
      apiGet<AuditLog[]>(`/projects/${projectId}/logs`)
    ]);
    const updated = projects.find((item) => item.id === projectId);
    if (updated) {
      setProject(updated);
    }
    setRenderLogs(logs);
  }

  async function loadProject(projectId: string) {
    setBusy(true);
    setError("");
    try {
      const [loadedProject, logs] = await Promise.all([
        apiGet<Project>(`/projects/${projectId}`),
        apiGet<AuditLog[]>(`/projects/${projectId}/logs`)
      ]);
      setProject(loadedProject);
      setRenderLogs(logs);
      setForm({
        ...defaultCreateForm,
        title: loadedProject.title,
        sourceText: loadedProject.sourceText,
        mode: loadedProject.mode,
        duration: loadedProject.duration,
        aspectRatio: loadedProject.aspectRatio
      });
      addLog("project_opened_from_dashboard", "פרויקט נטען מה-Dashboard", { projectId });
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "טעינת הפרויקט נכשלה");
    } finally {
      setBusy(false);
    }
  }

  async function downloadDiagnosticReport() {
    setDiagnosticMessage("");
    const latestLogs = project
      ? await apiGet<AuditLog[]>(`/projects/${project.id}/logs`).catch(() => renderLogs)
      : renderLogs;
    const latestProject = project
      ? await apiGet<Project>(`/projects/${project.id}`).catch(() => project)
      : undefined;
    const latestJob = latestProject?.renderJobs
      ?.slice()
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
    const report = {
      generatedAt: new Date().toISOString(),
      currentUrl: window.location.href,
      currentStatus: buildCurrentStatus({
        busy,
        project: latestProject,
        latestRenderJob: latestJob,
        actionLogs,
        renderLogs: latestLogs
      }),
      diagnosisHint: buildDiagnosisHint(latestProject, latestJob, latestLogs),
      stageBreakdown: buildStageBreakdown(latestProject, latestJob),
      form,
      project: latestProject,
      latestRenderJob: latestJob,
      actionLogs,
      renderLogs: latestLogs
    };
    const blob = new window.Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `adbot-diagnostic-${latestProject?.id ?? "no-project"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
    setDiagnosticMessage("דו״ח התקלה ירד למחשב. אפשר לשלוח אותו כאן בצ׳אט.");
    addLog("diagnostic_report_downloaded", "הורד דו״ח תקלה לשליחה לתמיכה", {
      projectId: latestProject?.id,
      renderLogCount: latestLogs.length,
      actionLogCount: actionLogs.length
    });
  }

  const latestRenderJob = project?.renderJobs
    ?.slice()
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
  const currentStatus = buildCurrentStatus({
    busy,
    project,
    latestRenderJob,
    actionLogs,
    renderLogs
  });
  const steps = ["בקשה", "תסריט", "ניתוח", "חומרים", "חבילת רינדור", "אישור"];

  return (
    <section>
      <div className="page-title">
        <p className="eyebrow">Pre‑Production</p>
        <h2>תסריט, ניתוח ואיסוף חומרים</h2>
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
          <div className="supporting-inputs">
            <label>קישורים נוספים לחומרי רקע / מוצר / מתחרים
              <textarea
                value={form.supplementalLinksText}
                placeholder={"קישור אחד בכל שורה, לדוגמה:\nhttps://example.com/product\nhttps://example.com/review"}
                onChange={(event) => updateForm("supplementalLinksText", event.target.value)}
              />
            </label>
            <label>העלאת תמונות או קבצי הסבר
              <input
                type="file"
                multiple
                accept="image/*,.txt,.md,.json,.csv,.pdf,.doc,.docx"
                onChange={(event) => setSupplementalFiles(Array.from(event.target.files ?? []).slice(0, 8))}
              />
            </label>
            <p className="muted">תמונות יישלחו ל-Gemini כרפרנס ויזואלי. קבצי טקסט/JSON/CSV/Markdown ייקראו וישולבו בהוראות התסריט.</p>
            {supplementalFiles.length > 0 && (
              <div className="file-chip-list">
                {supplementalFiles.map((file) => (
                  <span key={`${file.name}-${file.size}`}>{file.name} · {formatBytes(file.size)}</span>
                ))}
              </div>
            )}
          </div>
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
          <button className="primary" disabled={busy || !form.title || !hasPreProductionInput(form, supplementalFiles)} onClick={createProject}>{busy ? "מעבד..." : "יצירת תסריט"}</button>
          {error && <p className="notice error-notice">{error}</p>}
        </div>
        <div className="panel">
          <h3>תסריט, ניתוח וחבילת חומרים</h3>
          {!project && <p className="muted">לאחר יצירת התסריט יוצגו כאן סצנות של 7-8 שניות.</p>}
          {project && <p className="notice">{nextRequiredPreProductionStep(project)}</p>}
          {project && (
            <div className="stage-actions">
              <button className="secondary" disabled={busy || !["SCRIPT_READY", "SCRIPT_ANALYSIS_READY", "ASSETS_READY", "RENDER_PACKAGE_READY"].includes(project.status)} onClick={() => void analyzeProject()}>
                1. ניתוח תסריט חכם
              </button>
              <button className="secondary" disabled={busy || !["SCRIPT_ANALYSIS_READY", "ASSETS_READY", "RENDER_PACKAGE_READY"].includes(project.status)} onClick={() => void collectAssets()}>
                2. איסוף חומרים
              </button>
              <button className="secondary" disabled={busy || !["ASSETS_READY", "RENDER_PACKAGE_READY"].includes(project.status)} onClick={() => void buildRenderPackage()}>
                3. בניית חבילת רינדור
              </button>
              <button className="primary" disabled={busy || project.status !== "RENDER_PACKAGE_READY"} onClick={() => void approveRenderPackage()}>
                4. אישור חבילת הרינדור
              </button>
            </div>
          )}
          {project?.scriptAnalysis && (
            <details className="scene-details" open>
              <summary>ניתוח חכם של התסריט</summary>
              <code>{JSON.stringify(project.scriptAnalysis, null, 2)}</code>
            </details>
          )}
          {project?.renderPackage && (
            <details className="scene-details" open>
              <summary>חבילת רינדור מוכנה</summary>
              <code>{JSON.stringify(project.renderPackage, null, 2)}</code>
            </details>
          )}
          {project?.backgroundVideoPrompt && (
            <article className="scene prompt-card">
              <strong>סרטון רקע מומלץ</strong>
              <p>{project.backgroundVideoPrompt}</p>
            </article>
          )}
          {project?.musicPrompt && (
            <article className="scene prompt-card">
              <strong>מוסיקת רקע מומלצת</strong>
              <p>{project.musicPrompt}</p>
            </article>
          )}
          {project?.scenes.map((scene) => (
            <article key={scene.id} className="scene">
              <strong>{scene.title}</strong>
              <p>{scene.narration}</p>
              <small>{scene.visualPrompt} · {scene.durationSeconds}s</small>
              {scene.generationStatus === "fallback" && (
                <p className="notice warning-notice">שים לב: הסצנה נוצרה ב־FFmpeg fallback ולא דרך מחולל VIDEO אמיתי.</p>
              )}
              {scene.videoPrompt && (
                <details className="scene-details">
                  <summary>Prompt שנשלח לספק הווידאו</summary>
                  <code>{scene.videoPrompt}</code>
                </details>
              )}
              <div className="scene-generation-meta">
                {scene.videoProvider && <span>ספק וידאו: {scene.videoProvider}</span>}
                {scene.generationStatus && <span>סטטוס יצירה: {scene.generationStatus}</span>}
              </div>
              <div className="scene-assets">
                {(scene.referenceMediaUrl || scene.mediaUrl) && <a href={scene.referenceMediaUrl ?? scene.mediaUrl ?? ""} target="_blank">Reference media</a>}
                {scene.generatedVideoUrl && <a href={absoluteAssetUrl(scene.generatedVideoUrl)} target="_blank">Generated video</a>}
                {scene.voiceUrl && <a href={absoluteAssetUrl(scene.voiceUrl)} target="_blank">קול</a>}
                {scene.musicUrl && <a href={absoluteAssetUrl(scene.musicUrl)} target="_blank">מוסיקה</a>}
                {scene.clipUrl && <a href={absoluteAssetUrl(scene.clipUrl)} target="_blank" download>הורדת קליפ סצנה</a>}
              </div>
            </article>
          ))}
          {project && <button className="primary" disabled={busy || project.status !== "RENDER_PACKAGE_APPROVED"} onClick={renderProject}>
            {project.status === "RENDERING" ? "מרנדר..." : "שליחה לרינדור"}
          </button>}
        </div>
      </div>
      <CurrentOperationPanel status={currentStatus} />
      <div className="panel diagnostic-panel">
        <div>
          <h3>דו״ח תקלה</h3>
          <p className="muted">אם התהליך נתקע, הורד דו״ח ושלח אותו כאן. הוא כולל סטטוס פרויקט, סצנות, jobs ולוגים, ללא מפתחות API.</p>
        </div>
        <button className="secondary" onClick={() => void downloadDiagnosticReport()}>הורדת דו״ח תקלה</button>
        {diagnosticMessage && <p className="notice">{diagnosticMessage}</p>}
      </div>
      {project && (
        <div className="panel">
          <div className="log-header">
            <h3>תוצרי רינדור</h3>
            <button className="secondary" onClick={() => void refreshProject(project.id)}>רענון סטטוס</button>
          </div>
          <div className="download-grid">
            {project.renderJobs?.filter((job) => job.outputUrl).map((job) => (
              <a key={job.id} className="download-card" href={absoluteAssetUrl(job.outputUrl)} target="_blank" download>
                סרטון סופי · {job.status}
              </a>
            ))}
            {project.scenes.filter((scene) => scene.clipUrl).map((scene) => (
              <a key={scene.id} className="download-card" href={absoluteAssetUrl(scene.clipUrl)} target="_blank" download>
                קליפ סצנה {scene.order + 1} · {scene.durationSeconds}s
              </a>
            ))}
            {!project.renderJobs?.some((job) => job.outputUrl) && !project.scenes.some((scene) => scene.clipUrl) && (
              <p className="muted">עדיין אין קבצי וידאו להורדה. לאחר הרינדור יופיעו כאן הסרטונים.</p>
            )}
          </div>
        </div>
      )}
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
      {project && (
        <div className="panel">
          <div className="log-header">
            <h3>לוג רינדור מהשרת</h3>
            <button className="secondary" onClick={() => void refreshProject(project.id)}>רענון לוג</button>
          </div>
          {renderLogs.length === 0 && <p className="muted">לוג הרינדור יופיע לאחר שליחה לרינדור.</p>}
          <div className="operation-log">
            {renderLogs.map((log) => (
              <article key={log.id}>
                <strong>{String(log.metadata?.message ?? log.action)}</strong>
                <span>{new Date(log.createdAt).toLocaleTimeString("he-IL")} · {log.action}</span>
                {log.metadata && <code>{JSON.stringify(log.metadata)}</code>}
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

interface CurrentOperationStatus {
  stageLabel: string;
  startedAt?: string;
  progress: number;
  status: string;
  providerMessages: Array<{ at: string; message: string; step: string; metadata?: Record<string, unknown> }>;
}

function CurrentOperationPanel({ status }: { status: CurrentOperationStatus }) {
  return (
    <div className="panel current-operation">
      <div className="log-header">
        <div>
          <p className="eyebrow">Current Operation</p>
          <h3>{status.stageLabel}</h3>
        </div>
        <Badge value={status.status} />
      </div>
      <div className="operation-meta">
        <span>התחיל: {status.startedAt ? new Date(status.startedAt).toLocaleString("he-IL") : "טרם התחיל"}</span>
        <span>{status.progress}% בוצע</span>
      </div>
      <div className="progress-track">
        <div style={{ width: `${Math.min(100, Math.max(0, status.progress))}%` }} />
      </div>
      <h4>הודעות ספקים ושלבים</h4>
      {status.providerMessages.length === 0 && <p className="muted">עדיין אין הודעות מספקים או שלבי עיבוד.</p>}
      <div className="provider-message-list">
        {status.providerMessages.map((message, index) => (
          <article key={`${message.at}-${message.step}-${index}`}>
            <strong>{message.message}</strong>
            <span>{new Date(message.at).toLocaleTimeString("he-IL")} · {message.step}</span>
            {message.metadata && <code>{JSON.stringify(message.metadata)}</code>}
          </article>
        ))}
      </div>
    </div>
  );
}

function buildCurrentStatus(input: {
  busy: boolean;
  project?: Project;
  latestRenderJob?: RenderJob;
  actionLogs: OperationLog[];
  renderLogs: AuditLog[];
}): CurrentOperationStatus {
  const providerMessages = [
    ...input.renderLogs.map((log) => ({
      at: log.createdAt,
      step: log.action,
      message: String(log.metadata?.message ?? log.action),
      metadata: log.metadata
    })),
    ...input.actionLogs.map((log) => ({
      at: log.at,
      step: log.step,
      message: log.message,
      metadata: log.metadata
    }))
  ]
    .filter((log) => shouldShowAsProviderMessage(log.step))
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 8);

  if (input.latestRenderJob) {
    return {
      stageLabel: renderStageLabel(input.latestRenderJob.stage),
      startedAt: input.latestRenderJob.createdAt ?? input.renderLogs.at(-1)?.createdAt ?? input.latestRenderJob.updatedAt,
      progress: input.latestRenderJob.progress,
      status: input.latestRenderJob.status,
      providerMessages
    };
  }

  if (input.busy) {
    const firstBusyLog = [...input.actionLogs].reverse().find((log) => log.step.includes("create_script"));
    return {
      stageLabel: "יצירת תסריט",
      startedAt: firstBusyLog?.at,
      progress: 20,
      status: "RUNNING",
      providerMessages
    };
  }

  if (input.project?.status === "SCRIPT_READY") {
    return {
      stageLabel: "התסריט מוכן",
      startedAt: input.actionLogs.at(-1)?.at,
      progress: 35,
      status: "SCRIPT_READY",
      providerMessages
    };
  }

  const projectStage = projectStatusToOperation(input.project?.status);
  if (projectStage) {
    return {
      stageLabel: projectStage.label,
      startedAt: input.actionLogs.at(-1)?.at,
      progress: projectStage.progress,
      status: input.project?.status ?? "IDLE",
      providerMessages
    };
  }

  return {
    stageLabel: "ממתין להתחלה",
    progress: 0,
    status: "IDLE",
    providerMessages
  };
}

function buildDiagnosisHint(project?: Project, latestRenderJob?: RenderJob, renderLogs: AuditLog[] = []) {
  if (!project) {
    return "No project exists in the current create screen.";
  }

  if (project.status === "SCRIPT_READY" && !latestRenderJob) {
    return "Script is ready. Next step: run smart script analysis in Pre-Production.";
  }

  if (project.status === "SCRIPT_ANALYSIS_READY") {
    return "Script analysis is ready. Next step: collect assets for media, voice, avatars and music.";
  }

  if (project.status === "ASSETS_READY") {
    return "Assets are ready. Next step: build the render package with manifest, instructions and timeline.";
  }

  if (project.status === "RENDER_PACKAGE_READY") {
    return "Render package is ready. Next step: approve it manually before Render Studio can start rendering.";
  }

  if (project.status === "RENDER_PACKAGE_APPROVED" && !latestRenderJob) {
    return "Render package is approved. Open Render Studio and click render.";
  }

  if (latestRenderJob?.status === "QUEUED") {
    return "Render job is queued. Check whether the worker service is running.";
  }

  if (latestRenderJob?.status === "RUNNING") {
    const latestLog = renderLogs[0];
    return `Render is running at stage '${latestRenderJob.stage}'. Latest server log: ${latestLog?.action ?? "none"}.`;
  }

  if (latestRenderJob?.status === "FAILED") {
    return `Render failed: ${latestRenderJob.error ?? "no error message"}`;
  }

  if (latestRenderJob?.status === "COMPLETED") {
    return "Render completed. Check outputUrl and scene clipUrl values.";
  }

  return `Project status is ${project.status}.`;
}

function shouldShowAsProviderMessage(step: string) {
  return [
    "gemini",
    "source_url",
    "script_provider",
    "script_analysis",
    "media_provider",
    "voice_provider",
    "music_provider",
    "asset_collection",
    "render_package",
    "video_prompt",
    "video_provider",
    "scene_assets",
    "scene_render",
    "scene_video",
    "final_render",
    "render_job"
  ].some((prefix) => step.includes(prefix));
}

function renderStageLabel(stage: string) {
  if (stage.startsWith("scene_") && stage.endsWith("_assets")) {
    return `שליפת מדיה ומרכיבים · ${stage.replace("scene_", "סצנה ").replace("_assets", "")}`;
  }
  if (stage.startsWith("scene_") && stage.endsWith("_package_assets")) {
    return `קריאת חבילת חומרים · ${stage.replace("scene_", "סצנה ").replace("_package_assets", "")}`;
  }
  if (stage.startsWith("scene_") && stage.endsWith("_render")) {
    return `רינדור קליפ · ${stage.replace("scene_", "סצנה ").replace("_render", "")}`;
  }
  if (stage.startsWith("scene_") && stage.endsWith("_video_generation")) {
    return `יצירת וידאו אמיתי · ${stage.replace("scene_", "סצנה ").replace("_video_generation", "")}`;
  }

  const labels: Record<string, string> = {
    collect_assets: "שליפת מדיה, קול ומוסיקה",
    inline_rescue: "עיבוד ישיר משירות web",
    render: "רינדור סרטון",
    merge_final_video: "איחוד הסרטון הסופי",
    completed: "הושלם"
  };

  return labels[stage] ?? stage;
}

function projectStatusToOperation(status?: string) {
  const statuses: Record<string, { label: string; progress: number }> = {
    SCRIPT_ANALYZING: { label: "ניתוח תסריט חכם", progress: 45 },
    SCRIPT_ANALYSIS_READY: { label: "ניתוח תסריט מוכן", progress: 55 },
    ASSETS_COLLECTING: { label: "איסוף חומרים", progress: 65 },
    ASSETS_READY: { label: "ספריית חומרים מוכנה", progress: 75 },
    RENDER_PACKAGE_BUILDING: { label: "בניית חבילת רינדור", progress: 82 },
    RENDER_PACKAGE_READY: { label: "חבילת רינדור מוכנה לאישור", progress: 88 },
    RENDER_PACKAGE_APPROVED: { label: "חבילת רינדור מאושרת", progress: 92 },
    COMPLETED: { label: "הושלם", progress: 100 },
    FAILED: { label: "נכשל", progress: 100 }
  };
  return status ? statuses[status] : undefined;
}

function buildStageBreakdown(project?: Project, latestRenderJob?: RenderJob) {
  return {
    scriptStatus: project?.scenes?.length ? "ready" : "missing",
    scriptAnalysisStatus: project?.scriptAnalysis ? "ready" : "missing",
    assetCollectionStatus: project?.materialLibrary ? "ready" : "missing",
    renderPackageStatus: project?.renderPackage ? "ready" : "missing",
    renderPackageApprovedAt: project?.renderPackageApprovedAt ?? null,
    renderStatus: latestRenderJob?.status ?? "not_started",
    currentProjectStatus: project?.status ?? "no_project",
    currentRenderStage: latestRenderJob?.stage ?? null,
    missingAssets: readRenderPackageMissingAssets(project)
  };
}

function readRenderPackageMissingAssets(project?: Project) {
  const renderPackage = project?.renderPackage;
  if (!renderPackage || typeof renderPackage !== "object") {
    return [];
  }
  const missingAssets = renderPackage.missingAssets;
  return Array.isArray(missingAssets) ? missingAssets : [];
}

function nextRequiredPreProductionStep(project: Project) {
  const messages: Record<string, string> = {
    SCRIPT_READY: "השלב הבא: לחץ 1. ניתוח תסריט חכם. זה עדיין לא אישור לרינדור.",
    SCRIPT_ANALYZING: "המערכת מנתחת עכשיו את התסריט.",
    SCRIPT_ANALYSIS_READY: "השלב הבא: לחץ 2. איסוף חומרים.",
    ASSETS_COLLECTING: "המערכת אוספת עכשיו מדיה, קול ומוסיקה.",
    ASSETS_READY: "השלב הבא: לחץ 3. בניית חבילת רינדור.",
    RENDER_PACKAGE_BUILDING: "המערכת בונה עכשיו manifest, instructions ו-timeline.",
    RENDER_PACKAGE_READY: "השלב הבא: לחץ 4. אישור חבילת הרינדור. רק אחרי זה Render Studio יאשר רינדור.",
    RENDER_PACKAGE_APPROVED: "חבילת הרינדור מאושרת. עבור ל-Render Studio ולחץ שליחה לרינדור.",
    RENDERING: "הרינדור כבר פעיל. עקוב אחרי ההתקדמות ב-Render Studio.",
    COMPLETED: "הרינדור הושלם. ניתן להוריד את התוצרים.",
    FAILED: "הפעולה האחרונה נכשלה. בדוק את הלוג, תקן את הסיבה ונסה שוב מהשלב המתאים."
  };
  return messages[project.status] ?? `סטטוס נוכחי: ${project.status}`;
}

function RenderStudio() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [renderLogs, setRenderLogs] = useState<AuditLog[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const selectedProject = projects.find((project) => project.id === selectedProjectId);

  async function refresh(projectId = selectedProjectId) {
    const loadedProjects = await apiGet<Project[]>("/projects");
    setProjects(loadedProjects);
    const activeId = projectId || loadedProjects.find((project) => project.status === "RENDER_PACKAGE_APPROVED")?.id || loadedProjects[0]?.id || "";
    setSelectedProjectId(activeId);
    if (activeId) {
      setRenderLogs(await apiGet<AuditLog[]>(`/projects/${activeId}/logs`));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!selectedProject || selectedProject.status !== "RENDERING") {
      return undefined;
    }
    const interval = window.setInterval(() => void refresh(selectedProject.id), 5000);
    return () => window.clearInterval(interval);
  }, [selectedProject]);

  async function startRender() {
    if (!selectedProject) {
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await apiPost<RenderJob>(`/projects/${selectedProject.id}/render`);
      setMessage("הרינדור נשלח. המערכת קוראת את חבילת החומרים המאושרת ומייצרת קובץ סופי.");
      await refresh(selectedProject.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "שליחה לרינדור נכשלה");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="page-title">
        <p className="eyebrow">Render Studio</p>
        <h2>רינדור מחבילת חומרים מאושרת</h2>
      </div>
      <div className="two-col">
        <div className="panel">
          <label>בחירת פרויקט
            <select value={selectedProjectId} onChange={(event) => void refresh(event.target.value)}>
              <option value="">בחר פרויקט</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.title} · {project.status}</option>
              ))}
            </select>
          </label>
          {selectedProject && (
            <>
              <Badge value={selectedProject.status} />
              {selectedProject.status !== "RENDER_PACKAGE_APPROVED" && selectedProject.status !== "RENDERING" && selectedProject.status !== "COMPLETED" && (
                <p className="notice warning-notice">{nextRequiredPreProductionStep(selectedProject)}</p>
              )}
              {selectedProject.status === "RENDER_PACKAGE_APPROVED" && (
                <p className="notice">חבילת הרינדור מאושרת. אפשר לשלוח לרינדור.</p>
              )}
              <button className="primary" disabled={busy || selectedProject.status !== "RENDER_PACKAGE_APPROVED"} onClick={() => void startRender()}>
                {busy ? "שולח..." : "שליחה לרינדור"}
              </button>
              {message && <p className="notice">{message}</p>}
            </>
          )}
        </div>
        <div className="panel">
          <h3>חבילת הרינדור</h3>
          {!selectedProject?.renderPackage && <p className="muted">אין עדיין חבילת רינדור לפרויקט הזה.</p>}
          {selectedProject?.renderPackage && <code className="json-block">{JSON.stringify(selectedProject.renderPackage, null, 2)}</code>}
        </div>
      </div>
      {selectedProject && (
        <div className="panel">
          <div className="log-header">
            <h3>לוג רינדור ותוצרים</h3>
            <button className="secondary" onClick={() => void refresh(selectedProject.id)}>רענון</button>
          </div>
          <div className="download-grid">
            {selectedProject.renderJobs?.filter((job) => job.outputUrl).map((job) => (
              <a key={job.id} className="download-card" href={absoluteAssetUrl(job.outputUrl)} target="_blank" download>
                הורדת סרטון סופי · {job.status}
              </a>
            ))}
            {selectedProject.scenes.filter((scene) => scene.clipUrl).map((scene) => (
              <a key={scene.id} className="download-card" href={absoluteAssetUrl(scene.clipUrl)} target="_blank" download>
                הורדת קליפ סצנה {scene.order + 1}
              </a>
            ))}
          </div>
          <div className="operation-log">
            {renderLogs.map((log) => (
              <article key={log.id}>
                <strong>{String(log.metadata?.message ?? log.action)}</strong>
                <span>{new Date(log.createdAt).toLocaleTimeString("he-IL")} · {log.action}</span>
                {log.metadata && <code>{JSON.stringify(log.metadata)}</code>}
              </article>
            ))}
          </div>
        </div>
      )}
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

function splitSupplementalLinks(value: string) {
  return value
    .split(/\r?\n|,/)
    .map((link) => link.trim())
    .filter(Boolean);
}

function hasPreProductionInput(form: CreateForm, files: File[]) {
  return Boolean(form.sourceText.trim() || form.supplementalLinksText.trim() || files.length);
}

function inferAssetType(file: File) {
  if (file.type.startsWith("image/")) {
    return "IMAGE";
  }
  if (file.type.startsWith("video/")) {
    return "VIDEO";
  }
  if (file.type.startsWith("audio/")) {
    return "MUSIC";
  }
  return "SCRIPT";
}

async function readFileForScriptContext(file: File): Promise<Pick<SupplementalFileInput, "extractedText" | "imageDataUrl">> {
  if (file.type.startsWith("image/")) {
    return { imageDataUrl: await readFileAsDataUrl(file) };
  }

  if (isTextLikeFile(file)) {
    return { extractedText: (await file.text()).slice(0, 12000) };
  }

  return {};
}

function isTextLikeFile(file: File) {
  const lowerName = file.name.toLowerCase();
  return file.type.startsWith("text/")
    || ["application/json", "application/xml", "image/svg+xml"].includes(file.type)
    || [".txt", ".md", ".csv", ".json", ".xml", ".svg"].some((extension) => lowerName.endsWith(extension));
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

function formatBytes(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const providerServiceTypes = [
  { type: "SCRIPT", label: "תסריט", description: "מודלי AI לכתיבת תסריטים וחלוקה לסצנות.", presets: [["gemini", "Gemini Script Writer"], ["openai", "OpenAI Script Writer"], ["anthropic", "Claude Script Writer"]] },
  { type: "MEDIA", label: "מדיה", description: "חיפוש ושליפת תמונות ווידאו ממאגרים.", presets: [["pexels", "Pexels Media Search"], ["shutterstock", "Shutterstock"], ["unsplash", "Unsplash"]] },
  { type: "VOICE", label: "קול", description: "TTS, קריינות וקבצי קול לסרטונים.", presets: [["openverse", "Openverse Audio Search"], ["elevenlabs", "ElevenLabs Voiceover"], ["murf", "Murf Voice"], ["playht", "Play.ht Voice"]] },
  { type: "MUSIC", label: "מוסיקה", description: "מוסיקת רקע, קבצי קול וספריות סאונד.", presets: [["openverse", "Openverse Audio Search"], ["epidemic", "Epidemic Sound"], ["artlist", "Artlist"]] },
  { type: "AVATAR", label: "אווטרים", description: "יצירת דמויות/דוברים וירטואליים.", presets: [["heygen", "HeyGen"], ["did", "D-ID"], ["synthesia", "Synthesia"]] },
  { type: "VIDEO", label: "יצירת וידאו", description: "רינדור או יצירת קליפים לכל סצנה. Shotstack מרנדר כל בקשה כמקטע של 5 שניות.", presets: [["shotstack", "Shotstack 5 Second Renderer"], ["runway", "Runway"], ["kling", "Kling AI"], ["gemini", "Gemini Video"]] },
  { type: "MERGE", label: "מיזוג", description: "חיבור סצנות, כתוביות, watermark ו־transitions.", presets: [["ffmpeg", "Self-hosted FFmpeg"], ["shotstack", "Shotstack"], ["creatomate", "Creatomate"]] },
  { type: "STORAGE", label: "אחסון", description: "שמירת קבצים ותוצרים סופיים.", presets: [["local", "Local Storage"], ["cloudflare-r2", "Cloudflare R2"], ["s3", "AWS S3"], ["cloudinary", "Cloudinary"]] },
  { type: "DISTRIBUTION", label: "הפצה", description: "פרסום לרשתות, webhooks וערוצי יציאה.", presets: [["youtube", "YouTube"], ["instagram", "Instagram"], ["tiktok", "TikTok"], ["linkedin", "LinkedIn"]] }
] as const;

type ProviderFormState = {
  model: string;
  temperature: number;
  endpoint: string;
  timeoutSeconds: number;
  shotstackResolution: string;
  shotstackTextToSpeech: boolean;
};

function providerConfigForForm(activeType: string, form: ProviderFormState) {
  if (activeType === "SCRIPT") {
    return {
      model: form.model.trim() || "gemini-2.5-flash-lite",
      temperature: Number(form.temperature)
    };
  }

  if (activeType === "VIDEO") {
    return {
      endpoint: form.endpoint.trim(),
      timeoutSeconds: Number(form.timeoutSeconds),
      resolution: form.shotstackResolution,
      textToSpeech: form.shotstackTextToSpeech
    };
  }

  return {};
}

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
    model: "gemini-2.5-flash-lite",
    temperature: 0.7,
    endpoint: "",
    timeoutSeconds: 180,
    shotstackResolution: "sd",
    shotstackTextToSpeech: true
  });
  useEffect(() => {
    void apiGet<Provider[]>("/settings/services").then(setProviders);
  }, []);

  useEffect(() => {
    localStorage.setItem("promovid:settings-active-type", activeType);
  }, [activeType]);

  const activeService = providerServiceTypes.find((service) => service.type === activeType) ?? providerServiceTypes[0];
  const activeProviders = useMemo(() => providers.filter((provider) => provider.type === activeType), [activeType, providers]);

  function refreshProviders() {
    return apiGet<Provider[]>("/settings/services").then(setProviders);
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
        model: "gemini-2.5-flash-lite",
        temperature: 0.7,
        endpoint: "",
        timeoutSeconds: 180,
        shotstackResolution: "sd",
        shotstackTextToSpeech: true
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
        model: typeof provider.config?.model === "string" ? provider.config.model : "gemini-2.5-flash-lite",
        temperature: Number(provider.config?.temperature ?? 0.7),
        endpoint: typeof provider.config?.endpoint === "string" ? provider.config.endpoint : "",
        timeoutSeconds: Number(provider.config?.timeoutSeconds ?? 180),
        shotstackResolution: typeof provider.config?.resolution === "string" ? provider.config.resolution : "sd",
        shotstackTextToSpeech: typeof provider.config?.textToSpeech === "boolean" ? provider.config.textToSpeech : true
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
        config: providerConfigForForm(activeType, form)
      };

      if (selectedId === "new") {
        await apiPost<Provider>("/settings/services", payload);
      } else {
        await apiPatch<Provider>(`/settings/services/${selectedId}`, payload);
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
                model: "gemini-2.5-flash-lite",
                temperature: 0.7,
                endpoint: "",
                timeoutSeconds: 180,
                shotstackResolution: "sd",
                shotstackTextToSpeech: true
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
                <input list="gemini-models" value={form.model} placeholder="gemini-2.5-flash-lite" onChange={(event) => setForm({ ...form, model: event.target.value })} />
                <datalist id="gemini-models">
                  <option value="gemini-2.5-flash-lite" />
                  <option value="gemini-2.5-flash" />
                  <option value="gemini-2.0-flash" />
                  <option value="gemini-2.0-flash-lite" />
                </datalist>
              </label>
              <label>Temperature
                <input type="number" min="0" max="2" step="0.1" value={form.temperature} onChange={(event) => setForm({ ...form, temperature: Number(event.target.value) })} />
              </label>
            </div>
          )}
          {activeType === "VIDEO" && (
            <div className="video-provider-config">
              <label>Endpoint / Webhook URL אופציונלי
                <input value={form.endpoint} placeholder="ריק ל-Runway ישיר, או webhook שמחזיר videoUrl" onChange={(event) => setForm({ ...form, endpoint: event.target.value })} />
              </label>
              <label>Timeout בשניות
                <input type="number" min="30" max="900" step="10" value={form.timeoutSeconds} onChange={(event) => setForm({ ...form, timeoutSeconds: Number(event.target.value) })} />
              </label>
              <label>Shotstack · רזולוציה (חיסכון בקרדיטים)
                <select value={form.shotstackResolution} onChange={(event) => setForm({ ...form, shotstackResolution: event.target.value })}>
                  <option value="sd">SD (ברירת מחדל, זול יותר)</option>
                  <option value="hd">HD</option>
                  <option value="preview">Preview</option>
                </select>
              </label>
              <label className="checkbox-label">
                <input type="checkbox" checked={form.shotstackTextToSpeech} onChange={(event) => setForm({ ...form, shotstackTextToSpeech: event.target.checked })} />
                Shotstack · דיבור מובנה (TTS) בסרטון
              </label>
              <p className="muted">Shotstack: ברירת המחדל היא SD ומקטעים של 5 שניות. ללא TTS אפשר להסתמך על קובץ קול מהאיסוף (מוזג ב־FFmpeg אחרי הרינדור). Runway/Kling/Gemini דורשים endpoint או מפתח מתאים.</p>
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
                setForm({ type: activeType, provider, displayName, apiKey: "", priority: 1, enabled: true, model: provider === "gemini" ? "gemini-2.5-flash-lite" : "", temperature: 0.7, endpoint: "", timeoutSeconds: 180, shotstackResolution: "sd", shotstackTextToSpeech: true });
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
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>
);
