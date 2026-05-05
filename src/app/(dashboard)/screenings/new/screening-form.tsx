"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Plus, Trash2, ArrowLeft, Building2, User } from "lucide-react";
import type { Person } from "@/lib/types";
import { expandLvVariants } from "@/lib/name-variants";
import Link from "next/link";

/**
 * Shows the variants the engine will ALSO search beyond what the user typed.
 * Computed via the same `expandLvVariants` the server uses, so what the user
 * sees here is exactly what the screening will run.
 *
 * Renders nothing if `inputs` is empty or no auto-variants are derived.
 */
function VariantPreview({ inputs }: { inputs: string[] }) {
  const cleaned = inputs.map(s => s.trim()).filter(s => s.length > 0);
  if (cleaned.length === 0) return null;

  const originals = new Set(cleaned);
  const auto = new Set<string>();
  for (const input of cleaned) {
    for (const variant of expandLvVariants(input)) {
      if (!originals.has(variant)) auto.add(variant);
    }
  }
  if (auto.size === 0) return null;

  const list = Array.from(auto);
  return (
    <p className="text-xs text-emerald-400/80 mt-1.5 italic">
      We&rsquo;ll also search: {list.map(v => `"${v}"`).join(", ")}
    </p>
  );
}

const JURISDICTIONS = [
  { value: "LV", label: "Latvia" },
];

// Freemium gate: non-superusers get DEMO_LIMIT screenings before being asked
// to email about a pilot. Superusers bypass entirely (env-var gated).
const DEMO_LIMIT = 3;
const DEMO_LIMIT_SENTINEL = "__DEMO_LIMIT_REACHED__";
const CONTACT_HREF =
  "mailto:sigvards@krongorns.com?subject=Klirs%20pilot%20%E2%80%94%20more%20screenings";

/**
 * Client form component. `isSuperuser` is computed server-side in the parent
 * page.tsx wrapper (which can read SUPERUSER_EMAILS from env) and passed in.
 *
 * Why this separation: the previous implementation read `process.env.SUPERUSER_EMAILS`
 * via the `SUPERUSERS` constant in this client component. Next.js only exposes
 * env vars to the client when prefixed with `NEXT_PUBLIC_`, so the constant
 * always resolved to `[]` and nobody ever got the superuser bypass. The check
 * is now sourced from a server-side prop.
 */
export function ScreeningForm({ isSuperuser }: { isSuperuser: boolean }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [entityName, setEntityName] = useState("");
  const [entityType, setEntityType] = useState<"company" | "individual">("company");
  const [jurisdiction, setJurisdiction] = useState("LV");
  const [registrationNumber, setRegistrationNumber] = useState("");
  const [persons, setPersons] = useState<Person[]>([{ name: "", role: "", aliases: [] }]);

  // For individual-type screenings, aliases attach directly to the Full Name (no
  // separate "persons" concept for individuals — the named person IS the subject).
  const [individualAliases, setIndividualAliases] = useState<string[]>([]);

  const addIndividualAlias = () => setIndividualAliases([...individualAliases, ""]);
  const updateIndividualAlias = (i: number, value: string) => {
    const updated = [...individualAliases];
    updated[i] = value;
    setIndividualAliases(updated);
  };
  const removeIndividualAlias = (i: number) => {
    setIndividualAliases(individualAliases.filter((_, idx) => idx !== i));
  };

  const addPerson = () => setPersons([...persons, { name: "", role: "", aliases: [] }]);
  const removePerson = (index: number) => {
    if (persons.length <= 1) return;
    setPersons(persons.filter((_, i) => i !== index));
  };
  const updatePersonField = (index: number, field: "name" | "role", value: string) => {
    const updated = [...persons];
    updated[index] = { ...updated[index], [field]: value };
    setPersons(updated);
  };
  const addAlias = (personIndex: number) => {
    const updated = [...persons];
    updated[personIndex] = {
      ...updated[personIndex],
      aliases: [...(updated[personIndex].aliases || []), ""],
    };
    setPersons(updated);
  };
  const updateAlias = (personIndex: number, aliasIndex: number, value: string) => {
    const updated = [...persons];
    const aliases = [...(updated[personIndex].aliases || [])];
    aliases[aliasIndex] = value;
    updated[personIndex] = { ...updated[personIndex], aliases };
    setPersons(updated);
  };
  const removeAlias = (personIndex: number, aliasIndex: number) => {
    const updated = [...persons];
    const aliases = (updated[personIndex].aliases || []).filter((_, i) => i !== aliasIndex);
    updated[personIndex] = { ...updated[personIndex], aliases };
    setPersons(updated);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!entityName.trim()) {
      setError("Entity name is required");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setError("Not authenticated");
        setLoading(false);
        return;
      }

      // Check freemium limit (superusers bypass). `isSuperuser` is computed
      // server-side in the parent page.tsx and passed as a prop — see the
      // component docstring for the rationale.
      if (!isSuperuser) {
        const { count } = await supabase
          .from("screenings")
          .select("*", { count: "exact", head: true })
          .eq("created_by", user.id);

        if ((count || 0) >= DEMO_LIMIT) {
          setError(DEMO_LIMIT_SENTINEL);
          setLoading(false);
          return;
        }
      }

      // Persons payload differs by entity type:
      // - Individual: the named person IS the subject. The top-level "Aliases" field
      //   attaches directly to them. persons = [{name: fullName, aliases: [...]}].
      // - Company: the entity name is the company; persons = beneficial owners/directors,
      //   each with their own aliases nested under them.
      let validPersons: Person[];
      if (entityType === "individual") {
        const aliases = individualAliases.map(a => a.trim()).filter(a => a.length > 0);
        validPersons = [{ name: entityName.trim(), role: "", aliases }];
      } else {
        validPersons = persons
          .filter(p => p.name.trim())
          .map(p => ({
            ...p,
            aliases: (p.aliases || []).map(a => a.trim()).filter(a => a.length > 0),
          }));
      }

      const { data: screening, error: insertError } = await supabase
        .from("screenings")
        .insert({
          created_by: user.id,
          entity_name: entityName.trim(),
          entity_type: entityType,
          jurisdiction,
          registration_number: registrationNumber.trim() || null,
          persons: validPersons,
          status: "pending",
          is_demo: !isSuperuser,
        })
        .select()
        .single();

      if (insertError) throw insertError;

      // Trigger screening
      const runResponse = await fetch(`/api/screenings/${screening.id}/run`, {
        method: "POST",
      });

      if (!runResponse.ok) {
        console.error("Failed to start screening:", await runResponse.text());
      }

      router.push(`/screenings/${screening.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create screening");
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <Link href="/dashboard" className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white mb-6">
        <ArrowLeft className="w-4 h-4" />
        Back to Dashboard
      </Link>

      <h1 className="text-2xl font-bold text-white mb-2">New Screening</h1>
      <p className="text-sm text-slate-400 mb-8">
        Enter entity details to start an automated compliance screening
      </p>

      <form onSubmit={handleSubmit}>
        <Card className="bg-slate-900 border-white/10">
          <CardHeader>
            <CardTitle className="text-white">Entity Information</CardTitle>
            <CardDescription>The company or individual to screen</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Entity Type */}
            <div className="flex gap-3">
              <Button
                type="button"
                variant={entityType === "company" ? "default" : "outline"}
                onClick={() => setEntityType("company")}
                className={entityType === "company"
                  ? "bg-emerald-600 hover:bg-emerald-700 flex-1"
                  : "border-white/10 text-slate-300 flex-1"}
              >
                <Building2 className="w-4 h-4 mr-2" />
                Company
              </Button>
              <Button
                type="button"
                variant={entityType === "individual" ? "default" : "outline"}
                onClick={() => setEntityType("individual")}
                className={entityType === "individual"
                  ? "bg-emerald-600 hover:bg-emerald-700 flex-1"
                  : "border-white/10 text-slate-300 flex-1"}
              >
                <User className="w-4 h-4 mr-2" />
                Individual
              </Button>
            </div>

            {/* Entity Name */}
            <div>
              <Label className="text-slate-300">
                {entityType === "company" ? "Company Name" : "Full Name"}
              </Label>
              <Input
                value={entityName}
                onChange={(e) => setEntityName(e.target.value)}
                placeholder={entityType === "company" ? "e.g., AS Tet" : "e.g., John Smith"}
                className="mt-1.5 bg-slate-800 border-white/10 text-white placeholder:text-slate-600"
                required
              />
              {/* For company: variant preview just for the company name. For individual: */}
              {/* the combined preview lives under the Aliases section below. */}
              {entityType === "company" && <VariantPreview inputs={[entityName]} />}
            </div>

            {/* Jurisdiction */}
            <div>
              <Label className="text-slate-300">Jurisdiction</Label>
              <select
                value={jurisdiction}
                onChange={(e) => setJurisdiction(e.target.value)}
                className="mt-1.5 w-full h-10 rounded-md bg-slate-800 border border-white/10 text-white px-3 text-sm"
              >
                {JURISDICTIONS.map(j => (
                  <option key={j.value} value={j.value}>{j.label}</option>
                ))}
              </select>
            </div>

            {/* Registration Number */}
            {entityType === "company" && (
              <div>
                <Label className="text-slate-300">Registration Number (optional)</Label>
                <Input
                  value={registrationNumber}
                  onChange={(e) => setRegistrationNumber(e.target.value)}
                  placeholder="e.g., 40003052786"
                  className="mt-1.5 bg-slate-800 border-white/10 text-white placeholder:text-slate-600"
                />
              </div>
            )}

            {/* Individual-type Aliases (top level, attached to Full Name above) */}
            {entityType === "individual" && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <Label className="text-slate-300">Aliases / Alternative Spellings</Label>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Sanctions lists often index names under a canonical Latin spelling, so locally-transliterated or
                      alternative spellings of the same person can miss without an alias. Each alias runs a full database sweep.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={addIndividualAlias}
                    className="text-emerald-400 hover:text-emerald-300 shrink-0 ml-3"
                  >
                    <Plus className="w-4 h-4 mr-1" />
                    Add alias
                  </Button>
                </div>
                {individualAliases.length === 0 ? (
                  <p className="text-xs text-slate-600 italic">No aliases — only &ldquo;{entityName || "Full Name"}&rdquo; (plus auto-derived spelling variants) will be searched.</p>
                ) : (
                  <div className="space-y-2">
                    {individualAliases.map((alias, i) => (
                      <div key={i} className="flex gap-2">
                        <Input
                          value={alias}
                          onChange={(e) => updateIndividualAlias(i, e.target.value)}
                          placeholder={i === 0 ? "e.g., John Smith" : "Alternative spelling"}
                          className="bg-slate-800 border-white/10 text-white placeholder:text-slate-600 flex-1"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeIndividualAlias(i)}
                          className="text-slate-500 hover:text-red-400 shrink-0"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                {/* Auto-derived spelling variants (LV transliteration heuristic). */}
                <VariantPreview inputs={[entityName, ...individualAliases]} />
              </div>
            )}

            {/* Company-type Beneficial Owners (with per-person aliases) */}
            {entityType === "company" && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <Label className="text-slate-300">
                  Beneficial Owners / Directors
                </Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={addPerson}
                  className="text-emerald-400 hover:text-emerald-300"
                >
                  <Plus className="w-4 h-4 mr-1" />
                  Add Person
                </Button>
              </div>

              <div className="space-y-4">
                {persons.map((person, i) => (
                  <div key={i} className="space-y-2 border border-white/5 rounded-lg p-3 bg-slate-950/30">
                    <div className="flex gap-2">
                      <Input
                        value={person.name}
                        onChange={(e) => updatePersonField(i, "name", e.target.value)}
                        placeholder="Full name"
                        className="bg-slate-800 border-white/10 text-white placeholder:text-slate-600 flex-1"
                      />
                      <Input
                        value={person.role}
                        onChange={(e) => updatePersonField(i, "role", e.target.value)}
                        placeholder="Role (e.g., Director)"
                        className="bg-slate-800 border-white/10 text-white placeholder:text-slate-600 w-40"
                      />
                      {persons.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removePerson(i)}
                          className="text-slate-500 hover:text-red-400 shrink-0"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      )}
                    </div>

                    {/* Aliases */}
                    <div className="pl-2 border-l border-white/5">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs text-slate-500">
                          Aliases {(person.aliases?.length || 0) > 0 && `(${person.aliases!.length})`}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => addAlias(i)}
                          className="text-slate-400 hover:text-emerald-300 h-6 px-2 text-xs"
                        >
                          <Plus className="w-3 h-3 mr-1" />
                          Add alias
                        </Button>
                      </div>
                      {(person.aliases || []).map((alias, j) => (
                        <div key={j} className="flex gap-2 mb-1.5">
                          <Input
                            value={alias}
                            onChange={(e) => updateAlias(i, j, e.target.value)}
                            placeholder={j === 0 ? "e.g., John Smith" : "Alternative spelling"}
                            className="bg-slate-800 border-white/10 text-white placeholder:text-slate-600 flex-1 h-8 text-sm"
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => removeAlias(i, j)}
                            className="text-slate-500 hover:text-red-400 shrink-0 h-8"
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      ))}
                      <VariantPreview inputs={[person.name, ...(person.aliases || [])]} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
            )}

            {error && error === DEMO_LIMIT_SENTINEL && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
                <p className="text-sm font-semibold text-amber-200 mb-1">
                  Demo limit reached ({DEMO_LIMIT} screenings)
                </p>
                <p className="text-sm text-slate-300 mb-3 leading-relaxed">
                  You&rsquo;ve hit the free-tier limit. Drop us a line and
                  we&rsquo;ll get you set up with a pilot — full access, no
                  watermarks, audit-ready evidence bundles.
                </p>
                <a
                  href={CONTACT_HREF}
                  className="inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-medium px-4 py-2 rounded-md text-sm transition-colors"
                >
                  Email us about a pilot →
                </a>
              </div>
            )}

            {error && error !== DEMO_LIMIT_SENTINEL && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            <Button
              type="submit"
              disabled={loading}
              className="w-full bg-emerald-600 hover:bg-emerald-700 text-white h-11"
            >
              {loading ? "Starting Screening..." : "Start Screening"}
            </Button>
          </CardContent>
        </Card>
      </form>
    </div>
  );
}
