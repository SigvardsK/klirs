"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Download, X } from "lucide-react";
import type { AnnexVariant } from "@/lib/annex/variants";
import { ANNEX_META } from "@/lib/annex/variants";

interface Props {
  screeningId: string;
  variant: AnnexVariant;
  open: boolean;
  defaultReviewer: string;
  onOpenChange: (open: boolean) => void;
}

export function AnnexPreviewModal({
  screeningId,
  variant,
  open,
  defaultReviewer,
  onOpenChange,
}: Props) {
  const [reviewer, setReviewer] = useState(defaultReviewer);
  const meta = ANNEX_META[variant];

  const previewUrl = `/api/screenings/${screeningId}/annex/${variant}/preview?reviewer=${encodeURIComponent(reviewer)}`;
  const pdfUrl = `/api/screenings/${screeningId}/annex/${variant}/export.pdf?reviewer=${encodeURIComponent(reviewer)}`;
  const docxUrl = `/api/screenings/${screeningId}/annex/${variant}/export.docx?reviewer=${encodeURIComponent(reviewer)}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl sm:max-w-5xl w-[95vw] h-[92vh] p-0 overflow-hidden flex flex-col">
        <DialogHeader className="px-5 py-3 border-b border-white/10 shrink-0">
          <div className="flex items-start justify-between gap-4">
            <div>
              <DialogTitle className="text-white text-base">
                {meta.code} — {meta.titleLv}
              </DialogTitle>
              <p className="text-xs text-slate-400 mt-0.5">{meta.titleEn}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <label className="text-xs text-slate-400 whitespace-nowrap">Atbildīgā persona:</label>
              <Input
                value={reviewer}
                onChange={(e) => setReviewer(e.target.value)}
                placeholder="Vārds, uzvārds"
                className="h-8 w-48 text-xs"
              />
              <a href={pdfUrl}>
                <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 gap-1.5">
                  <Download className="w-3.5 h-3.5" />
                  PDF
                </Button>
              </a>
              <a href={docxUrl}>
                <Button size="sm" variant="outline" className="gap-1.5 border-white/20">
                  <Download className="w-3.5 h-3.5" />
                  DOCX
                </Button>
              </a>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                className="h-8 w-8 p-0"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </DialogHeader>
        <div className="flex-1 bg-white overflow-hidden">
          <iframe
            key={previewUrl}
            src={previewUrl}
            title={`${meta.code} preview`}
            className="w-full h-full border-0"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
