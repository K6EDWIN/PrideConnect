"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { readApiResponse } from "@/lib/read-api-response";

const inputClass = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-[#c8102e] focus:ring-2 focus:ring-[#c8102e]/10";

export default function TwoFactorSettings() {
  const [status, setStatus] = useState(null);
  const [method, setMethod] = useState("AUTHENTICATOR");
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [disableToken, setDisableToken] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadStatus = async () => {
    try {
      const response = await fetch("/api/account/security", { cache: "no-store" });
      const data = await readApiResponse(response, "Could not load security settings");
      setStatus(data);
      if (data.enabled) setMethod(data.method);
    } catch (loadError) {
      setError(loadError.message);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => loadStatus(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const startSetup = async () => {
    setBusy(true); setError(""); setNotice(""); setSetup(null); setCode("");
    try {
      const response = await fetch("/api/account/security", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method }),
      });
      const data = await readApiResponse(response, "Could not start two-step verification");
      setSetup(data);
      setNotice(data.message || "Scan the QR code, then confirm with a current authenticator code.");
    } catch (setupError) { setError(setupError.message); }
    finally { setBusy(false); }
  };

  const confirmSetup = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/account/security", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: setup?.method, code, challengeToken: setup?.challengeToken }),
      });
      const data = await readApiResponse(response, "Could not confirm two-step verification");
      setStatus({ enabled: true, method: data.method, remainingRecoveryCodes: data.recoveryCodes.length });
      setRecoveryCodes(data.recoveryCodes);
      setSetup(null); setCode("");
      setNotice("Two-step verification is on. Save these recovery codes now; they are shown only once.");
    } catch (confirmError) { setError(confirmError.message); }
    finally { setBusy(false); }
  };

  const resendSetupCode = async (challengeToken) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/account/security/resend", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challengeToken }),
      });
      const data = await readApiResponse(response, "Could not resend the verification code");
      setNotice(data.message || "A new code was sent.");
    } catch (resendError) { setError(resendError.message); }
    finally { setBusy(false); }
  };

  const disable = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/account/security", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, code, ...(disableToken ? { challengeToken: disableToken } : {}) }),
      });
      const data = await readApiResponse(response, "Could not turn off two-step verification");
      if (data.needsCode) {
        setDisableToken(data.challengeToken);
        setNotice(data.message);
      } else {
        setStatus({ enabled: false, method: null, remainingRecoveryCodes: 0 });
        setDisableToken(""); setPassword(""); setCode(""); setNotice(data.message);
      }
    } catch (disableError) { setError(disableError.message); }
    finally { setBusy(false); }
  };

  const downloadRecoveryCodes = () => {
    const content = `PrideConnect recovery codes\nStore these somewhere private. Each code works once.\n\n${recoveryCodes.join("\n")}\n`;
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = "prideconnect-recovery-codes.txt"; link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="card space-y-5 p-6 sm:p-8" aria-labelledby="security-settings-heading">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4">
        <div>
          <h2 id="security-settings-heading" className="text-base font-bold text-slate-900">Account security</h2>
          <p className="mt-1 text-sm text-slate-600">Add a second verification step for every sign-in. This applies to member and administrator accounts.</p>
        </div>
        {status && <span className={`rounded-full px-3 py-1 text-xs font-semibold ${status.enabled ? "bg-emerald-50 text-emerald-800" : "bg-slate-100 text-slate-700"}`}>{status.enabled ? "Two-step verification on" : "Not enabled"}</span>}
      </div>

      {!status && !error && <p role="status" className="text-sm text-slate-600">Loading security settings…</p>}
      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      {notice && <p role="status" className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">{notice}</p>}

      {!status?.enabled && !setup && !recoveryCodes.length && <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <label className="block text-sm font-semibold text-slate-700">Verification method
          <select value={method} onChange={(event) => setMethod(event.target.value)} className={`${inputClass} mt-1.5`}>
            <option value="AUTHENTICATOR">Authenticator app</option>
            <option value="EMAIL">Email code</option>
          </select>
        </label>
        <button type="button" onClick={startSetup} disabled={busy || !status} className="rounded-lg bg-[#c8102e] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#a00d24] disabled:opacity-50">{busy ? "Preparing…" : "Set up two-step verification"}</button>
      </div>}

      {setup && <div className="grid gap-5 md:grid-cols-[240px_1fr]">
        {setup.qrCodeDataUrl && <div className="rounded-xl border border-slate-200 bg-white p-3 text-center">
          <Image src={setup.qrCodeDataUrl} alt="Authenticator app setup QR code" width={216} height={216} unoptimized className="mx-auto h-auto max-w-full" />
          <p className="mt-2 text-xs text-slate-600">Scan with Google Authenticator, Microsoft Authenticator, or another TOTP app.</p>
          <details className="mt-2 text-left"><summary className="cursor-pointer text-xs font-semibold text-slate-700">Enter setup key manually</summary><code className="mt-2 block break-all rounded bg-slate-100 p-2 text-xs text-slate-900">{setup.secret}</code></details>
        </div>}
        <div className="space-y-3">
          {setup.method === "EMAIL" && <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">We sent a six-digit code to your registered email. The code expires in five minutes. <button type="button" onClick={() => resendSetupCode(setup.challengeToken)} disabled={busy} className="ml-1 font-semibold text-[#c8102e] hover:underline disabled:opacity-50">Resend code</button></div>}
          <label className="block text-sm font-semibold text-slate-700">Enter verification code
            <input value={code} onChange={(event) => setCode(event.target.value.trim())} autoComplete="one-time-code" maxLength={11} className={`${inputClass} mt-1.5`} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={confirmSetup} disabled={busy || !code} className="rounded-lg bg-[#c8102e] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Checking…" : "Confirm and enable"}</button>
            <button type="button" onClick={() => { setSetup(null); setCode(""); }} className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700">Cancel</button>
          </div>
        </div>
      </div>}

      {status?.enabled && !recoveryCodes.length && <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
          <p><strong>Method:</strong> {status.method === "EMAIL" ? "Email code" : "Authenticator app"}</p>
          <p className="mt-1"><strong>Unused recovery codes:</strong> {status.remainingRecoveryCodes}</p>
          <p className="mt-2 text-xs text-slate-600">Each recovery code works once if you lose access to your normal method. To change methods, turn this off and set it up again.</p>
        </div>
        <div className="space-y-2">
          <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Current password" className={inputClass} />
          <input value={code} onChange={(event) => setCode(event.target.value.trim())} placeholder={status.method === "EMAIL" && !disableToken ? "Confirmation code will be emailed" : "Authenticator or recovery code"} autoComplete="one-time-code" maxLength={11} className={inputClass} />
          {status.method === "EMAIL" && disableToken && <button type="button" onClick={() => resendSetupCode(disableToken)} disabled={busy} className="text-xs font-semibold text-[#c8102e] hover:underline disabled:opacity-50">Resend confirmation code</button>}
          <button type="button" onClick={disable} disabled={busy || !password} className="rounded-lg border border-red-300 px-4 py-2.5 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50">{busy ? "Checking…" : "Turn off two-step verification"}</button>
        </div>
      </div>}

      {recoveryCodes.length > 0 && <div className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
        <p className="text-sm font-semibold text-amber-950">Store these codes securely. They will not be shown again.</p>
        <ul className="grid grid-cols-2 gap-2 font-mono text-sm text-slate-900 sm:grid-cols-3">{recoveryCodes.map((recoveryCode) => <li key={recoveryCode} className="rounded bg-white px-3 py-2">{recoveryCode}</li>)}</ul>
        <div className="flex flex-wrap gap-2"><button type="button" onClick={downloadRecoveryCodes} className="rounded-lg border border-amber-500 px-3 py-2 text-sm font-semibold text-amber-950">Download codes</button><button type="button" onClick={() => { setRecoveryCodes([]); loadStatus(); }} className="rounded-lg bg-amber-800 px-3 py-2 text-sm font-semibold text-white">I saved my codes</button></div>
      </div>}
    </section>
  );
}
