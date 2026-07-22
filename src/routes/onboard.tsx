import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

export const Route = createFileRoute("/onboard")({
  component: OnboardPage,
});

// ── Types ──────────────────────────────────────────────────────

type Step = 1 | 2 | 3;

interface FormData {
  // Step 1 – Account
  name: string;
  email: string;
  license_type: string;
  // Step 2 – License Details
  license_issuance_date: string;
  license_renewal_date: string;
  financial_year_end: string;
  custom_fye_month: string;
  custom_fye_day: string;
  activity_type: string;
  // Step 3 – Revenue
  revenue_entries: { amount: string; date: string; category: string }[];
}

const STEP_LABELS: Record<Step, string> = {
  1: "Account",
  2: "License Details",
  3: "Revenue",
};

const FINANCIAL_YEAR_OPTIONS = [
  { value: "12-31", label: "December 31" },
  { value: "06-30", label: "June 30" },
  { value: "03-31", label: "March 31" },
  { value: "09-30", label: "September 30" },
  { value: "custom", label: "Custom" },
];

const LICENSE_TYPE_OPTIONS = [
  { value: "freelance", label: "Freelance Permit" },
  { value: "freezone", label: "Free Zone Company" },
  { value: "mainland", label: "Mainland / DED" },
];

const INITIAL_FORM: FormData = {
  name: "",
  email: "",
  license_type: "",
  license_issuance_date: "",
  license_renewal_date: "",
  financial_year_end: "",
  custom_fye_month: "",
  custom_fye_day: "",
  activity_type: "",
  revenue_entries: [],
};

// ── Components ─────────────────────────────────────────────────

function StepIndicator({ current }: { current: Step }) {
  return (
    <nav aria-label="Onboarding progress" className="mb-10">
      <ol className="flex items-center justify-center gap-4 sm:gap-6">
        {([1, 2, 3] as Step[]).map((s) => {
          const isActive = s === current;
          const isDone = s < current;
          return (
            <li key={s} className="flex items-center gap-2">
              <span
                className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold transition-colors ${
                  isActive
                    ? "bg-navy-800 text-white"
                    : isDone
                      ? "bg-emerald-600 text-white"
                      : "bg-gray-200 text-gray-500"
                }`}
                aria-current={isActive ? "step" : undefined}
              >
                {isDone ? "✓" : s}
              </span>
              <span
                className={`hidden text-sm font-medium sm:inline ${
                  isActive ? "text-navy-800" : "text-gray-400"
                }`}
              >
                {STEP_LABELS[s]}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function FormField({
  label,
  htmlFor,
  error,
  optional,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-gray-700">
        {label}
        {optional && <span className="ml-1 text-xs text-gray-400">(optional)</span>}
      </label>
      {children}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────

function OnboardPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>(1);
  const [form, setForm] = useState<FormData>(INITIAL_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState("");

  const update = (field: keyof FormData, value: unknown) =>
    setForm((f) => ({ ...f, [field]: value }));

  // ── Validation per step ──────────────────────────────

  function validateStep(s: Step): Record<string, string> {
    const e: Record<string, string> = {};
    if (s === 1) {
      if (!form.name.trim()) e.name = "Full name is required";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email))
        e.email = "A valid email is required";
      if (!form.license_type) e.license_type = "Select a license type";
    }
    if (s === 2) {
      if (!form.license_issuance_date) e.license_issuance_date = "License issuance date is required";
      if (!form.financial_year_end) e.financial_year_end = "Select a financial year end";
      if (form.financial_year_end === "custom") {
        if (!form.custom_fye_month || Number(form.custom_fye_month) < 1 || Number(form.custom_fye_month) > 12)
          e.custom_fye_month = "Enter a valid month (1–12)";
        if (!form.custom_fye_day || Number(form.custom_fye_day) < 1 || Number(form.custom_fye_day) > 31)
          e.custom_fye_day = "Enter a valid day (1–31)";
      }
    }
    return e;
  }

  function nextStep() {
    const e = validateStep(step);
    setErrors(e);
    if (Object.keys(e).length === 0) setStep((s) => (s < 3 ? ((s + 1) as Step) : s));
  }

  function prevStep() {
    setStep((s) => (s > 1 ? ((s - 1) as Step) : s));
  }

  // ── Revenue entry management ────────────────────────

  const addRevenueEntry = () =>
    update("revenue_entries", [
      ...form.revenue_entries,
      { amount: "", date: "", category: "invoice" },
    ]);

  const removeRevenueEntry = (idx: number) =>
    update(
      "revenue_entries",
      form.revenue_entries.filter((_, i) => i !== idx),
    );

  const updateRevenueEntry = (
    idx: number,
    field: "amount" | "date" | "category",
    value: string,
  ) =>
    update(
      "revenue_entries",
      form.revenue_entries.map((e, i) => (i === idx ? { ...e, [field]: value } : e)),
    );

  // ── Submit ──────────────────────────────────────────

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const e2 = validateStep(step);
    setErrors(e2);
    if (Object.keys(e2).length > 0) return;

    setSubmitting(true);
    setServerError("");

    try {
      const fye =
        form.financial_year_end === "custom"
          ? `${String(form.custom_fye_month).padStart(2, "0")}-${String(form.custom_fye_day).padStart(2, "0")}`
          : form.financial_year_end;

      // 1. Create client
      const clientRes = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          email: form.email.trim().toLowerCase(),
          license_type: form.license_type,
          license_issuance_date: form.license_issuance_date,
          license_renewal_date: form.license_renewal_date || undefined,
          financial_year_end: fye,
          activity_type: form.activity_type.trim() || undefined,
        }),
      });

      if (!clientRes.ok) {
        const err = await clientRes.json().catch(() => ({ error: "Failed to create account" }));
        setServerError(err.error ?? "Failed to create account");
        setSubmitting(false);
        return;
      }

      const client = await clientRes.json();

      // 2. Add revenue entries
      const validEntries = form.revenue_entries.filter(
        (e) => e.amount.trim() && e.date.trim(),
      );
      for (const entry of validEntries) {
        await fetch("/api/revenue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: client.id,
            amount_aed: Number.parseFloat(entry.amount),
            entry_date: entry.date,
            category: entry.category,
          }),
        });
      }

      // 3. Redirect to dashboard
      navigate({ to: "/dashboard/$id", params: { id: String(client.id) } });
    } catch {
      setServerError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render ──────────────────────────────────────────

  return (
    <main className="flex min-h-dvh flex-col items-center bg-sand-50 px-4 py-10 sm:py-16">
      <div className="w-full max-w-xl">
        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-navy-900 sm:text-3xl">
            Set up your compliance tracking
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            We&apos;ll organize your UAE corporate tax deadlines and track your
            thresholds — all in one place.
          </p>
        </div>

        <StepIndicator current={step} />

        {serverError && (
          <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {serverError}
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          {/* ── Step 1: Account ─────────────────────── */}
          {step === 1 && (
            <fieldset className="space-y-5">
              <legend className="sr-only">Account details</legend>
              <FormField label="Full Name" htmlFor="name" error={errors.name}>
                <input
                  id="name"
                  type="text"
                  autoComplete="name"
                  value={form.name}
                  onChange={(e) => update("name", e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm shadow-sm placeholder:text-gray-400 focus:border-navy-500 focus:outline-none focus:ring-1 focus:ring-navy-500"
                  placeholder="Ahmed Al-Rashid"
                />
              </FormField>
              <FormField label="Email" htmlFor="email" error={errors.email}>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={form.email}
                  onChange={(e) => update("email", e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm shadow-sm placeholder:text-gray-400 focus:border-navy-500 focus:outline-none focus:ring-1 focus:ring-navy-500"
                  placeholder="ahmed@example.com"
                />
              </FormField>
              <FormField label="License Type" htmlFor="license_type" error={errors.license_type}>
                <select
                  id="license_type"
                  value={form.license_type}
                  onChange={(e) => update("license_type", e.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3.5 py-2.5 text-sm shadow-sm focus:border-navy-500 focus:outline-none focus:ring-1 focus:ring-navy-500"
                >
                  <option value="">Select license type…</option>
                  {LICENSE_TYPE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </FormField>
            </fieldset>
          )}

          {/* ── Step 2: License Details ─────────────── */}
          {step === 2 && (
            <fieldset className="space-y-5">
              <legend className="sr-only">License details</legend>
              <FormField
                label="License Issuance Date"
                htmlFor="license_issuance_date"
                error={errors.license_issuance_date}
              >
                <input
                  id="license_issuance_date"
                  type="date"
                  value={form.license_issuance_date}
                  onChange={(e) => update("license_issuance_date", e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm shadow-sm focus:border-navy-500 focus:outline-none focus:ring-1 focus:ring-navy-500"
                />
              </FormField>
              <FormField
                label="License Renewal Date"
                htmlFor="license_renewal_date"
                optional
              >
                <input
                  id="license_renewal_date"
                  type="date"
                  value={form.license_renewal_date}
                  onChange={(e) => update("license_renewal_date", e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm shadow-sm focus:border-navy-500 focus:outline-none focus:ring-1 focus:ring-navy-500"
                />
              </FormField>
              <FormField
                label="Financial Year End"
                htmlFor="financial_year_end"
                error={errors.financial_year_end}
              >
                <select
                  id="financial_year_end"
                  value={form.financial_year_end}
                  onChange={(e) => update("financial_year_end", e.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3.5 py-2.5 text-sm shadow-sm focus:border-navy-500 focus:outline-none focus:ring-1 focus:ring-navy-500"
                >
                  <option value="">Select financial year end…</option>
                  {FINANCIAL_YEAR_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </FormField>
              {form.financial_year_end === "custom" && (
                <div className="flex gap-3">
                  <div className="flex-1">
                    <FormField label="Month" htmlFor="custom_month" error={errors.custom_fye_month}>
                      <input
                        id="custom_month"
                        type="number"
                        min={1}
                        max={12}
                        value={form.custom_fye_month}
                        onChange={(e) => update("custom_fye_month", e.target.value)}
                        className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm shadow-sm focus:border-navy-500 focus:outline-none focus:ring-1 focus:ring-navy-500"
                        placeholder="12"
                      />
                    </FormField>
                  </div>
                  <div className="flex-1">
                    <FormField label="Day" htmlFor="custom_day" error={errors.custom_fye_day}>
                      <input
                        id="custom_day"
                        type="number"
                        min={1}
                        max={31}
                        value={form.custom_fye_day}
                        onChange={(e) => update("custom_fye_day", e.target.value)}
                        className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm shadow-sm focus:border-navy-500 focus:outline-none focus:ring-1 focus:ring-navy-500"
                        placeholder="31"
                      />
                    </FormField>
                  </div>
                </div>
              )}
              <FormField label="Activity Type" htmlFor="activity_type" optional>
                <input
                  id="activity_type"
                  type="text"
                  value={form.activity_type}
                  onChange={(e) => update("activity_type", e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm shadow-sm placeholder:text-gray-400 focus:border-navy-500 focus:outline-none focus:ring-1 focus:ring-navy-500"
                  placeholder="e.g. consulting, e-commerce, design"
                />
              </FormField>
            </fieldset>
          )}

          {/* ── Step 3: Revenue ─────────────────────── */}
          {step === 3 && (
            <fieldset className="space-y-5">
              <legend className="sr-only">Revenue entries</legend>
              <div>
                <p className="text-sm font-medium text-gray-700">
                  Add your known revenue entries to get started
                </p>
                <p className="text-xs text-gray-400">
                  This helps us track your threshold status. You can add more later.
                </p>
              </div>

              {form.revenue_entries.length === 0 && (
                <div className="rounded-lg border border-dashed border-gray-300 px-4 py-8 text-center text-sm text-gray-400">
                  No revenue entries added yet.
                  <br />
                  <button
                    type="button"
                    onClick={addRevenueEntry}
                    className="mt-2 text-navy-600 underline underline-offset-2 hover:text-navy-800"
                  >
                    Add your first entry
                  </button>
                </div>
              )}

              {form.revenue_entries.map((entry, idx) => (
                <div
                  key={idx}
                  className="relative rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
                >
                  <button
                    type="button"
                    onClick={() => removeRevenueEntry(idx)}
                    className="absolute right-3 top-3 rounded p-1 text-gray-300 hover:text-red-500"
                    aria-label="Remove revenue entry"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-500">
                        Amount (AED)
                      </label>
                      <input
                        type="number"
                        min={0}
                        value={entry.amount}
                        onChange={(e) => updateRevenueEntry(idx, "amount", e.target.value)}
                        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-navy-500 focus:outline-none focus:ring-1 focus:ring-navy-500"
                        placeholder="50000"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-500">
                        Date
                      </label>
                      <input
                        type="date"
                        value={entry.date}
                        onChange={(e) => updateRevenueEntry(idx, "date", e.target.value)}
                        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-navy-500 focus:outline-none focus:ring-1 focus:ring-navy-500"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-500">
                        Category
                      </label>
                      <select
                        value={entry.category}
                        onChange={(e) => updateRevenueEntry(idx, "category", e.target.value)}
                        className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-navy-500 focus:outline-none focus:ring-1 focus:ring-navy-500"
                      >
                        <option value="invoice">Invoice</option>
                        <option value="service">Service</option>
                        <option value="product">Product</option>
                        <option value="other">Other</option>
                      </select>
                    </div>
                  </div>
                </div>
              ))}

              {form.revenue_entries.length > 0 && (
                <button
                  type="button"
                  onClick={addRevenueEntry}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-4 py-2 text-sm text-gray-500 hover:border-navy-400 hover:text-navy-700"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Add another entry
                </button>
              )}
            </fieldset>
          )}

          {/* ── Navigation buttons ─────────────────── */}
          <div className="mt-8 flex items-center justify-between">
            <div>
              {step > 1 && (
                <button
                  type="button"
                  onClick={prevStep}
                  className="rounded-lg px-4 py-2.5 text-sm font-medium text-gray-600 hover:text-navy-800"
                >
                  ← Back
                </button>
              )}
            </div>
            <div className="flex gap-3">
              {step === 3 && (
                <button
                  type="button"
                  onClick={() =>
                    handleSubmit(new Event("submit") as unknown as FormEvent)
                  }
                  className="rounded-lg px-4 py-2.5 text-sm font-medium text-gray-500 hover:text-gray-700"
                  disabled={submitting}
                >
                  Skip for now
                </button>
              )}
              {step < 3 ? (
                <button
                  type="button"
                  onClick={nextStep}
                  className="rounded-lg bg-navy-800 px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-navy-700 focus:outline-none focus:ring-2 focus:ring-navy-500 focus:ring-offset-2"
                >
                  Continue
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-lg bg-amber-500 px-6 py-2.5 text-sm font-semibold text-navy-900 shadow-sm transition hover:bg-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 disabled:opacity-60"
                >
                  {submitting ? "Creating account…" : "Complete setup"}
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </main>
  );
}
