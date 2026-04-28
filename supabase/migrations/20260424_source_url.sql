-- Add source_url to screening_checks so the UI can link each check row back to
-- the live database query page. Reviewer feedback: screenshots alone aren't
-- auditable — reviewers need the live URL to verify findings independently.

alter table public.screening_checks
  add column if not exists source_url text;

comment on column public.screening_checks.source_url is
  'Live URL of the query result page (page.url() captured by the Playwright engine at screenshot time). Nullable for legacy rows and for checks that errored before navigation.';
