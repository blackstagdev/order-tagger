import "@shopify/polaris/build/esm/styles.css";
import { useState, useCallback } from "react";
import { useFetcher, useLoaderData } from "react-router";
import {
  AppProvider as PolarisAppProvider,
  Page, Card, BlockStack, InlineStack, Text, Button, TextField,
  DropZone, Banner, Badge, Box, ChoiceList,
} from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { collectMatches, applyTag } from "../orders.server";
import prisma from "../db.server";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const taggers = await prisma.tagger.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { customers: true } } },
  });
  return { taggers };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  if (intent === "delete") {
    const id = Number(form.get("id"));
    if (id) await prisma.tagger.deleteMany({ where: { id, shop } });
    return { ok: true };
  }

  const name = String(form.get("name") || "").trim();
  const tag = String(form.get("tag") || "").trim();
  const mode = String(form.get("mode") || "ongoing");
  const start = String(form.get("start") || "").trim() || null;
  const end = mode === "range" ? (String(form.get("end") || "").trim() || null) : null;
  let emails: string[] = [];
  try { emails = JSON.parse(String(form.get("emails") || "[]")); } catch { emails = []; }
  emails = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];

  if (!name) return { error: "Give the tagger a name." };
  if (!tag) return { error: "Enter a tag." };
  if (!emails.length) return { error: "Upload a CSV with customer emails." };
  if (!start) return { error: "Pick a start date." };
  if (mode === "range" && !end) return { error: "Pick an end date for a fixed range." };

  try {
    await prisma.tagger.create({
      data: {
        shop, name, tag,
        startDate: new Date(`${start}T00:00:00Z`),
        endDate: end ? new Date(`${end}T23:59:59Z`) : null,
        customers: { create: emails.map((email) => ({ email })) },
      },
    });

    const { matches } = await collectMatches(admin, emails, tag, start, end);
    const toTag = matches.filter((m) => !m.alreadyTagged).map((m) => m.id);
    const results = await applyTag(admin, toTag, tag);

    return {
      created: true,
      name,
      tagged: results.filter((r) => r.ok).length,
      matched: matches.length,
      ongoing: !end,
    };
  } catch (e: any) { return { error: String(e?.message || e) }; }
};

function parseCsv(text: string): string[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return [];
  const header = lines[0].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
  let col = header.findIndex((c) => /e-?mail/i.test(c));
  let startRow = 0;
  if (col >= 0) startRow = 1; else col = 0;
  const out: string[] = [];
  for (let i = startRow; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const v = (cols[col] || "").trim().toLowerCase();
    if (v && /@/.test(v)) out.push(v);
  }
  return [...new Set(out)];
}

function dateLabel(t: any) {
  const s = t.startDate ? new Date(t.startDate).toLocaleDateString() : "any time";
  if (!t.endDate) return `from ${s} onward (ongoing)`;
  return `${s} to ${new Date(t.endDate).toLocaleDateString()}`;
}

function App() {
  const { taggers } = useLoaderData<any>();
  const fetcher = useFetcher<any>();
  const busy = fetcher.state !== "idle";
  const data = fetcher.data;

  const [fileName, setFileName] = useState("");
  const [emails, setEmails] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [tag, setTag] = useState("");
  const [mode, setMode] = useState<string[]>(["ongoing"]);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  const isRange = mode[0] === "range";

  const handleDrop = useCallback((_drop: File[], accepted: File[]) => {
    const file = accepted[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const parsed = parseCsv(String(e.target?.result || ""));
      setEmails(parsed);
      setFileName(`${file.name} — ${parsed.length} unique email(s)`);
    };
    reader.readAsText(file);
  }, []);

  const create = () => {
    fetcher.submit(
      { intent: "create", name, tag, mode: mode[0], start, end, emails: JSON.stringify(emails) },
      { method: "POST" },
    );
  };
  const remove = (id: number, nm: string) => {
    if (window.confirm(`Delete tagger "${nm}"? Future orders won't be auto-tagged anymore. Tags already applied stay.`)) {
      fetcher.submit({ intent: "delete", id: String(id) }, { method: "POST" });
    }
  };

  const canCreate = !!(name.trim() && tag.trim() && emails.length > 0 && start && (!isRange || end));

  return (
    <Page>
      <TitleBar title="Order Tagger" />
      <BlockStack gap="500">
        {data?.error && (<Banner tone="critical" title="Something went wrong"><p>{data.error}</p></Banner>)}
        {data?.created && (
          <Banner tone="success" title={`Tagger "${data.name}" created`}>
            <p>
              Tagged {data.tagged} existing order(s) out of {data.matched} matched.
              {data.ongoing ? " Future orders from these customers will be tagged automatically." : ""}
            </p>
          </Banner>
        )}

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">Create a tagger</Text>
            <TextField label="Campaign name" value={name} onChange={setName} autoComplete="off" placeholder="e.g. June VIP campaign" />
            <TextField label="Tag to apply" value={tag} onChange={setTag} autoComplete="off" placeholder="e.g. vip-june" />
            <DropZone accept=".csv,text/csv" type="file" onDrop={handleDrop} allowMultiple={false}>
              {fileName ? (<Box padding="400"><Text as="p">{fileName}</Text></Box>)
                : (<DropZone.FileUpload actionTitle="Add CSV" actionHint="Customer emails" />)}
            </DropZone>
            <ChoiceList
              title="Which orders should this tag?"
              choices={[
                { label: "From a start date onward — includes future orders automatically", value: "ongoing" },
                { label: "A fixed date range only", value: "range" },
              ]}
              selected={mode}
              onChange={setMode}
            />
            <InlineStack gap="400" wrap>
              <Box minWidth="170px">
                <TextField label="Start date" type="date" value={start} onChange={setStart} autoComplete="off" />
              </Box>
              {isRange && (
                <Box minWidth="170px">
                  <TextField label="End date" type="date" value={end} onChange={setEnd} autoComplete="off" />
                </Box>
              )}
            </InlineStack>
            <InlineStack>
              <Button variant="primary" onClick={create} loading={busy && fetcher.formData?.get("intent") === "create"} disabled={!canCreate}>
                Save tagger &amp; tag orders
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Your taggers</Text>
            {taggers.length === 0 ? (
              <Text as="p" tone="subdued">No taggers yet — create one above.</Text>
            ) : (
              taggers.map((t: any) => {
                const active = !t.endDate || new Date(t.endDate) >= new Date();
                return (
                  <Box key={t.id} padding="300" borderWidth="025" borderColor="border" borderRadius="200">
                    <InlineStack align="space-between" blockAlign="center" wrap gap="200">
                      <BlockStack gap="100">
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="span" variant="headingSm">{t.name}</Text>
                          {active ? <Badge tone="success">Active</Badge> : <Badge>Ended</Badge>}
                        </InlineStack>
                        <Text as="span" tone="subdued">
                          Tag &ldquo;{t.tag}&rdquo; · {t._count.customers} customer(s) · {dateLabel(t)}
                        </Text>
                      </BlockStack>
                      <Button tone="critical" variant="plain" onClick={() => remove(t.id, t.name)}>Delete</Button>
                    </InlineStack>
                  </Box>
                );
              })
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

export default function IndexRoute() {
  return (<PolarisAppProvider i18n={enTranslations}><App /></PolarisAppProvider>);
}
