"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

export type ShowcaseImage = {
  src: string;
  alt: string;
  caption: string;
};

export function ProductShowcase({ images }: { images: ShowcaseImage[] }) {
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const isOpen = selectedIdx !== null;

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedIdx(null);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen]);

  const selected = selectedIdx !== null ? images[selectedIdx] : null;

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {images.map((s, i) => (
          <figure
            key={s.src}
            className="rounded-lg border border-white/10 bg-slate-800/50 overflow-hidden flex flex-col"
          >
            <button
              type="button"
              onClick={() => setSelectedIdx(i)}
              className="group relative block w-full overflow-hidden cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
              aria-label={`Open larger view: ${s.alt}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={s.src}
                alt={s.alt}
                className="w-full h-auto transition-transform duration-300 group-hover:scale-[1.03]"
              />
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"
              />
            </button>
            <figcaption className="p-4 text-sm text-slate-300 leading-relaxed">
              {s.caption}
            </figcaption>
          </figure>
        ))}
      </div>

      {selected && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={selected.alt}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 sm:p-8 animate-in fade-in-0 duration-150"
          onClick={() => setSelectedIdx(null)}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setSelectedIdx(null);
            }}
            className="absolute top-4 right-4 rounded-full bg-white/10 hover:bg-white/20 text-white p-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
          <figure
            onClick={(e) => e.stopPropagation()}
            className="max-w-6xl w-full max-h-full flex flex-col items-center"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={selected.src}
              alt={selected.alt}
              className="max-w-full max-h-[80vh] w-auto h-auto object-contain rounded-lg shadow-2xl"
            />
            <figcaption className="mt-4 text-center text-sm text-slate-300 max-w-2xl">
              {selected.caption}
            </figcaption>
          </figure>
        </div>
      )}
    </>
  );
}
