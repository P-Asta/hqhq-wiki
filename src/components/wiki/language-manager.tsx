"use client";

/**
 * Languages registry manager (routes.md /languages: anon view, editor
 * propose, admin activate/deactivate). The server page renders the initial
 * registry (with per-language page/outdated counts); this island layers on
 * the authenticated actions against /api/languages.
 */

import { useState } from "react";
import type { FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { FieldMessage } from "@/components/ui/field-message";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useAuth } from "@/components/auth-provider";
import { CELL_CLASSES, CELL_MONO_CLASSES, Chip, SpecialTable } from "@/components/wiki/special-table";
import { formatMessage } from "@/lib/i18n";

export interface LanguageRegistryRow {
  code: string;
  label: string;
  nativeName: string;
  direction: "ltr" | "rtl";
  status: "active" | "proposed";
  /** Locale heads (translated pages) in this language. */
  pages: number;
  /** Stale translations in this language (0 for en). */
  outdated: number;
}

export interface LanguageManagerLabels {
  columnCode: string;
  columnName: string;
  columnNativeName: string;
  columnStatus: string;
  columnPages: string;
  columnOutdated: string;
  columnActions: string;
  statusActive: string;
  statusProposed: string;
  proposeTitle: string;
  proposeDescription: string;
  directionLabel: string;
  directionLtr: string;
  directionRtl: string;
  proposeAction: string;
  activateAction: string;
  deactivateAction: string;
  signInToPropose: string;
  proposeSuccess: string;
  /** "{message}" placeholder. */
  requestFailed: string;
}

export interface LanguageManagerProps {
  rows: LanguageRegistryRow[];
  labels: LanguageManagerLabels;
}

interface ApiLanguage {
  code: string;
  label: string;
  nativeName: string;
  direction: "ltr" | "rtl";
  status: "active" | "proposed";
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string; code?: string } };
    return body.error?.message ?? body.error?.code ?? String(res.status);
  } catch {
    return String(res.status);
  }
}

export function LanguageManager({ rows: initialRows, labels }: LanguageManagerProps) {
  const { profile, error: authError, isAdmin, getIdToken } = useAuth();
  // The resolved principal: a banned account may not propose a language.
  const canPropose = profile !== null && authError === null;
  const [rows, setRows] = useState(initialRows);
  const [busyCode, setBusyCode] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [proposing, setProposing] = useState(false);

  const fail = (message: string) =>
    setNotice({ tone: "error", text: formatMessage(labels.requestFailed, { message }) });

  const propose = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const payload = {
      code: String(data.get("code") ?? "").trim().toLowerCase(),
      label: String(data.get("label") ?? "").trim(),
      nativeName: String(data.get("nativeName") ?? "").trim(),
      direction: data.get("direction") === "rtl" ? ("rtl" as const) : ("ltr" as const),
    };
    if (!payload.code || !payload.label || !payload.nativeName) return;

    setProposing(true);
    setNotice(null);
    try {
      const token = await getIdToken();
      const res = await fetch("/api/languages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        fail(await readErrorMessage(res));
        return;
      }
      const { language } = (await res.json()) as { language: ApiLanguage };
      setRows((current) => [
        ...current.filter((row) => row.code !== language.code),
        { ...language, pages: 0, outdated: 0 },
      ].sort((a, b) => a.code.localeCompare(b.code)));
      setNotice({ tone: "success", text: labels.proposeSuccess });
      form.reset();
    } catch (err) {
      fail(err instanceof Error ? err.message : "network");
    } finally {
      setProposing(false);
    }
  };

  const setStatus = async (code: string, status: "active" | "proposed") => {
    setBusyCode(code);
    setNotice(null);
    try {
      const token = await getIdToken();
      const res = await fetch("/api/languages", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ code, status }),
      });
      if (!res.ok) {
        fail(await readErrorMessage(res));
        return;
      }
      const { language } = (await res.json()) as { language: ApiLanguage };
      setRows((current) =>
        current.map((row) => (row.code === language.code ? { ...row, status: language.status } : row)),
      );
    } catch (err) {
      fail(err instanceof Error ? err.message : "network");
    } finally {
      setBusyCode(null);
    }
  };

  const head = [
    labels.columnCode,
    labels.columnName,
    labels.columnNativeName,
    labels.columnStatus,
    labels.columnPages,
    labels.columnOutdated,
    ...(isAdmin ? [labels.columnActions] : []),
  ];

  return (
    <div className="flex flex-col gap-6">
      {notice ? (
        <FieldMessage tone={notice.tone === "success" ? "success" : "error"}>
          {notice.text}
        </FieldMessage>
      ) : null}

      <SpecialTable head={head}>
        {rows.map((row) => (
          <tr key={row.code} className="hover:bg-canvas-soft">
            <td className={CELL_MONO_CLASSES}>{row.code}</td>
            <td className={CELL_CLASSES}>{row.label}</td>
            <td className={CELL_CLASSES}>{row.nativeName}</td>
            <td className={CELL_CLASSES}>
              <Chip className={row.status === "active" ? "border-link text-link" : undefined}>
                {row.status === "active" ? labels.statusActive : labels.statusProposed}
              </Chip>
            </td>
            <td className={`${CELL_CLASSES} tabular-nums`}>{row.pages}</td>
            <td className={`${CELL_CLASSES} tabular-nums`}>{row.outdated}</td>
            {isAdmin ? (
              <td className={CELL_CLASSES}>
                {row.code === "en" ? null : row.status === "active" ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busyCode === row.code}
                    onClick={() => void setStatus(row.code, "proposed")}
                  >
                    {labels.deactivateAction}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busyCode === row.code}
                    onClick={() => void setStatus(row.code, "active")}
                  >
                    {labels.activateAction}
                  </Button>
                )}
              </td>
            ) : null}
          </tr>
        ))}
      </SpecialTable>

      {canPropose ? (
        <Card className="max-w-xl">
          <CardTitle>{labels.proposeTitle}</CardTitle>
          <CardDescription>{labels.proposeDescription}</CardDescription>
          <form onSubmit={(event) => void propose(event)} className="mt-4 flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="lang-code">{labels.columnCode}</Label>
                <Input
                  id="lang-code"
                  name="code"
                  required
                  maxLength={12}
                  pattern="[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*"
                  placeholder="ja"
                  className="font-mono"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="lang-direction">{labels.directionLabel}</Label>
                <Select id="lang-direction" name="direction" defaultValue="ltr">
                  <option value="ltr">{labels.directionLtr}</option>
                  <option value="rtl">{labels.directionRtl}</option>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="lang-label">{labels.columnName}</Label>
                <Input id="lang-label" name="label" required maxLength={64} placeholder="Japanese" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="lang-native">{labels.columnNativeName}</Label>
                <Input id="lang-native" name="nativeName" required maxLength={64} placeholder="日本語" />
              </div>
            </div>
            <div>
              <Button type="submit" disabled={proposing}>
                {labels.proposeAction}
              </Button>
            </div>
          </form>
        </Card>
      ) : (
        <p className="text-sm text-mute">{labels.signInToPropose}</p>
      )}
    </div>
  );
}
