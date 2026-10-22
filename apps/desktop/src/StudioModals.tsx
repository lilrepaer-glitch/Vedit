import { memo, useEffect, useMemo, useState } from "react";
import {
  api,
  withToken,
  type ApiSettingsResponse,
  type ExportPresetInfo,
  type Project,
} from "./api";
import { detectPresetByKey, MOBILE_API_PRESETS } from "./mobileRuntime";
import { IconCheck, IconClose, IconExport, IconRefresh, IconShare } from "./Icons";

// ---------- Clean Universal API Settings Modal (OpenAI, Gemini, Claude, OpenRouter, Groq, DeepSeek, Custom) ----------

export const ApiSettingsModal = memo(function ApiSettingsModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: ApiSettingsResponse | null;
  onClose: () => void;
  onSaved: (next: ApiSettingsResponse, msg: string) => void;
}) {
  const presets = initial?.presets?.length ? initial.presets : MOBILE_API_PRESETS;
  const [preset, setPreset] = useState(initial?.providerPreset ?? "openai");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "https://api.openai.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [model, setModel] = useState(initial?.model ?? "gpt-4o-mini");
  const [remoteModels, setRemoteModels] = useState<string[]>([]);
  const [modelFilter, setModelFilter] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api
      .getApiSettings()
      .then((cfg) => {
        setPreset(cfg.providerPreset);
        setBaseUrl(cfg.baseUrl);
        setModel(cfg.model);
      })
      .catch(() => undefined);
  }, []);

  const activePresetObj = useMemo(() => presets.find((p) => p.id === preset), [presets, preset]);

  const allCandidateModels = useMemo(() => {
    const merged = Array.from(
      new Set([model, ...(remoteModels.length ? remoteModels : activePresetObj?.suggestedModels ?? [])].filter(Boolean)),
    );
    const q = modelFilter.trim().toLowerCase();
    return q ? merged.filter((m) => m.toLowerCase().includes(q)) : merged;
  }, [model, remoteModels, activePresetObj, modelFilter]);

  const handlePresetChange = (nextId: string) => {
    setPreset(nextId);
    const found = presets.find((p) => p.id === nextId);
    if (found) {
      if (nextId !== "custom") setBaseUrl(found.baseUrl);
      if (found.suggestedModels[0]) setModel(found.suggestedModels[0]);
      setRemoteModels([]);
    }
  };

  // Auto-detect provider, Base URL, and default model as soon as user pastes a key!
  const handleKeyInput = (val: string) => {
    setApiKey(val);
    const auto = detectPresetByKey(val);
    if (auto) {
      setPreset(auto.id);
      setBaseUrl(auto.baseUrl);
      if (auto.suggestedModels[0]) setModel(auto.suggestedModels[0]);
      setStatusMsg({
        ok: true,
        text: `Auto-detected ${auto.label} key (${auto.baseUrl})`,
      });
    }
  };

  const handleFetchModels = async () => {
    setLoadingModels(true);
    setStatusMsg(null);
    try {
      const res = await api.fetchApiModels({
        baseUrl,
        apiKey: apiKey.trim() || undefined,
      });
      setRemoteModels(res.models);
      setBaseUrl(res.baseUrl);
      if (res.models.length > 0 && !res.models.includes(model)) {
        setModel(res.models[0]!);
      }
      setStatusMsg({
        ok: true,
        text: `Loaded ${res.models.length} models from ${res.baseUrl}`,
      });
    } catch (err) {
      setStatusMsg({
        ok: false,
        text: `Model list error: ${(err as Error).message}`,
      });
    } finally {
      setLoadingModels(false);
    }
  };

  const handleTestAndSave = async () => {
    setTesting(true);
    setStatusMsg(null);
    try {
      // Save first so runtime config immediately holds the clean key & URL
      const saved = await api.saveApiSettings({
        providerPreset: preset,
        baseUrl,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        model,
        visionModel: model,
      });
      setBaseUrl(saved.baseUrl);
      setModel(saved.model);

      const res = await api.testApiSettings({
        baseUrl: saved.baseUrl,
        apiKey: apiKey.trim() || undefined,
        model: saved.model,
      });
      onSaved(saved, `Connected: ${res.model} (${res.latencyMs}ms)`);
      setStatusMsg({
        ok: true,
        text: `Connected (${res.latencyMs}ms) · ${res.model}: "${res.reply}"`,
      });
    } catch (err) {
      setStatusMsg({
        ok: false,
        text: `${(err as Error).message}`,
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const saved = await api.saveApiSettings({
        providerPreset: preset,
        baseUrl,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        model,
        visionModel: model,
      });
      onSaved(saved, `Saved API settings (${saved.model})`);
      onClose();
    } catch (err) {
      setStatusMsg({ ok: false, text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>AI API Configuration</h2>
            <div style={{ marginTop: 3, fontSize: 12, color: "var(--text-secondary)" }}>
              OpenAI, Google Gemini, Anthropic Claude, OpenRouter, Groq, DeepSeek, or custom endpoint
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <IconClose size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text-secondary)" }}>
              <span>API Key</span>
              {initial?.hasApiKey && (
                <span style={{ color: "var(--success)", fontWeight: 500 }}>Active: {initial.maskedApiKey}</span>
              )}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => handleKeyInput(e.target.value)}
                placeholder={
                  initial?.hasApiKey
                    ? `Saved (${initial.maskedApiKey}) — paste new key to replace`
                    : "Paste sk-..., AIza..., sk-ant-..., sk-or-..., gsk_..."
                }
                autoComplete="off"
                spellCheck={false}
                style={{ flex: 1 }}
              />
              <button type="button" onClick={() => setShowKey((s) => !s)}>
                {showKey ? "Hide" : "Show"}
              </button>
              {initial?.hasApiKey && (
                <button
                  type="button"
                  className="btn-danger"
                  onClick={async () => {
                    const cleared = await api.saveApiSettings({ clearApiKey: true });
                    onSaved(cleared, "API key cleared");
                    setStatusMsg({ ok: true, text: "API key removed." });
                  }}
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          <div className="form-grid-2">
            <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, color: "var(--text-secondary)" }}>
              <span>Provider</span>
              <select value={preset} onChange={(e) => handlePresetChange(e.target.value)}>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, color: "var(--text-secondary)" }}>
              <span>Base URL</span>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
                spellCheck={false}
              />
            </label>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Model ID</span>
              <button type="button" onClick={handleFetchModels} disabled={loadingModels} style={{ padding: "4px 9px", fontSize: 11.5 }}>
                <IconRefresh size={13} />
                {loadingModels ? "Loading…" : "Fetch Models"}
              </button>
            </div>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="gpt-4o-mini / gemini-2.5-flash / claude-sonnet-4-20250514"
              spellCheck={false}
            />
            {allCandidateModels.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 2 }}>
                {remoteModels.length > 6 && (
                  <input
                    value={modelFilter}
                    onChange={(e) => setModelFilter(e.target.value)}
                    placeholder="Filter fetched models…"
                    style={{ padding: "5px 9px", fontSize: 12 }}
                  />
                )}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5, maxHeight: 112, overflowY: "auto" }}>
                  {allCandidateModels.slice(0, 60).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`chip-btn ${m === model ? "active" : ""}`}
                      onClick={() => setModel(m)}
                      style={{ fontSize: 11, padding: "4px 9px" }}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {statusMsg && (
            <div
              style={{
                padding: "9px 12px",
                borderRadius: 8,
                fontSize: 12,
                lineHeight: 1.4,
                background: statusMsg.ok ? "rgba(34, 197, 94, 0.12)" : "rgba(239, 68, 68, 0.12)",
                border: `1px solid ${statusMsg.ok ? "rgba(34, 197, 94, 0.35)" : "rgba(239, 68, 68, 0.35)"}`,
                color: statusMsg.ok ? "#86efac" : "#fca5a5",
                wordBreak: "break-word",
              }}
            >
              {statusMsg.text}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" onClick={handleTestAndSave} disabled={testing}>
            <IconCheck size={14} />
            {testing ? "Testing…" : "Test Connection"}
          </button>
          <button type="button" className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
});

// ---------- Clean Real Hardware Video Export Modal ----------

export const ExportModal = memo(function ExportModal({
  project,
  exportPresets,
  onClose,
  onFlash,
}: {
  project: Project;
  exportPresets: ExportPresetInfo[];
  onClose: () => void;
  onFlash: (msg: string) => void;
}) {
  const presets = exportPresets.length
    ? exportPresets
    : [
        { id: "youtube-1080p", label: "1080p Full HD · 30fps (MP4 H.264)", platform: "Universal", format: "mp4" as const, codec: "h264" as const },
        { id: "reels-vertical-1080p", label: "1080×1920 Vertical 9:16 · 60fps", platform: "Reels / TikTok", format: "mp4" as const, codec: "h264" as const },
        { id: "social-720p-fast", label: "720p Fast Share · 30fps", platform: "Mobile", format: "mp4" as const, codec: "h264" as const },
        { id: "cinema-24fps", label: "1080p Cinema · 24fps", platform: "Cinema", format: "mp4" as const, codec: "h264" as const },
      ];

  const [preset, setPreset] = useState(presets[0]!.id);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  const activeJob = useMemo(
    () => (activeJobId ? project.jobs.find((j) => j.id === activeJobId) : project.jobs[project.jobs.length - 1]),
    [project.jobs, activeJobId],
  );

  const isRunning = activeJob?.status === "queued" || activeJob?.status === "running";

  const startExport = async () => {
    try {
      const res = await api.exportRender(preset, "auto");
      setActiveJobId(res.jobId);
      onFlash("Rendering video…");
    } catch (err) {
      onFlash(`Export error: ${(err as Error).message}`);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Export Video</h2>
            <div style={{ marginTop: 3, fontSize: 12, color: "var(--text-secondary)" }}>
              Hardware H.264 + AAC MP4 with color grading, transitions, titles &amp; mixed audio
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <IconClose size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Quality &amp; Format</span>
            {presets.map((p) => (
              <div
                key={p.id}
                onClick={() => setPreset(p.id)}
                style={{
                  padding: "10px 12px",
                  borderRadius: 9,
                  cursor: "pointer",
                  background: preset === p.id ? "var(--accent-soft)" : "var(--panel-2)",
                  border: `1.5px solid ${preset === p.id ? "var(--accent)" : "var(--border)"}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{p.label}</div>
                  <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                    {p.platform} · {p.format.toUpperCase()}
                  </div>
                </div>
                {preset === p.id && <IconCheck size={16} style={{ color: "#60a5fa" }} />}
              </div>
            ))}
          </div>

          {activeJob && (
            <div
              style={{
                padding: 12,
                borderRadius: 10,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                <span style={{ fontWeight: 600 }}>
                  {activeJob.status === "done"
                    ? "Export complete"
                    : activeJob.status === "failed"
                      ? `Failed: ${activeJob.error ?? "Unknown error"}`
                      : "Encoding frames & audio…"}
                </span>
                <span className="mono">{activeJob.progress ?? 0}%</span>
              </div>
              <div style={{ height: 6, borderRadius: 999, background: "var(--panel-2)", overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    width: `${Math.max(2, activeJob.progress ?? 0)}%`,
                    background: activeJob.status === "done" ? "var(--success)" : "var(--accent)",
                    transition: "width 0.2s ease",
                  }}
                />
              </div>
              {activeJob.status === "done" && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11.5, color: "var(--success)" }}>
                    {String((activeJob.output as { path?: string } | undefined)?.path || "Saved to Gallery / Downloads")}
                  </span>
                  <div style={{ display: "flex", gap: 6 }}>
                    <a
                      href={withToken(`/api/v1/projects/${project.id}/jobs/${activeJob.id}/output`)}
                      download={`Vedit_Export.mp4`}
                      style={{
                        textDecoration: "none",
                        padding: "6px 11px",
                        borderRadius: 7,
                        background: "var(--panel-2)",
                        border: "1px solid var(--border-strong)",
                        color: "var(--text)",
                        fontSize: 12,
                        fontWeight: 500,
                      }}
                    >
                      Save File
                    </a>
                    <button
                      type="button"
                      className="btn-accent"
                      onClick={() => void api.shareExport()}
                    >
                      <IconShare size={14} /> Share
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn-primary" onClick={startExport} disabled={isRunning}>
            <IconExport size={14} />
            {isRunning ? `Rendering (${activeJob?.progress ?? 0}%)…` : "Export MP4"}
          </button>
        </div>
      </div>
    </div>
  );
});
