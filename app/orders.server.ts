/**
 * orders.server.ts
 * ----------------
 * Server-only logic for the Order Tagger app.
 * Drop this file at:  app/orders.server.ts
 *
 * Uses the authenticated `admin` GraphQL client provided by
 * `authenticate.admin(request)` in the route's loader/action.
 */

// Minimal shape of the admin client returned by authenticate.admin()
type Admin = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export type OrderMatch = {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  fulfillment: string | null;
  currentTags: string[];
  alreadyTagged: boolean;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ORDERS_QUERY = `#graphql
  query Orders($q: String!, $cursor: String) {
    orders(first: 50, query: $q, after: $cursor, sortKey: CREATED_AT) {
      edges {
        node {
          id
          name
          email
          createdAt
          displayFulfillmentStatus
          tags
          customer { email }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const TAGS_ADD = `#graphql
  mutation AddTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }`;

/** Run a GraphQL request with automatic backoff on Shopify throttling. */
async function gql(admin: Admin, query: string, variables: Record<string, unknown>) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await admin.graphql(query, { variables });
    const body: any = await res.json();

    if (body.errors) {
      const throttled = body.errors.some(
        (e: any) => e?.extensions?.code === "THROTTLED",
      );
      if (throttled) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw new Error(body.errors.map((e: any) => e.message).join("; "));
    }

    // Proactively slow down when the cost bucket runs low.
    const throttle = body.extensions?.cost?.throttleStatus;
    if (throttle && throttle.currentlyAvailable < 100) {
      const wait = ((100 - throttle.currentlyAvailable) / (throttle.restoreRate || 50)) * 1000;
      await sleep(Math.max(0, wait));
    }
    return body.data;
  }
  throw new Error("Repeatedly throttled by Shopify — try a smaller batch.");
}

function buildSearchQuery(email: string, start?: string | null, end?: string | null) {
  const parts = [`email:${email}`];
  if (start) parts.push(`created_at:>=${start}T00:00:00Z`);
  if (end) parts.push(`created_at:<=${end}T23:59:59Z`);
  return parts.join(" ");
}

async function findOrdersForEmail(
  admin: Admin,
  email: string,
  start?: string | null,
  end?: string | null,
) {
  const target = email.trim().toLowerCase();
  const q = buildSearchQuery(target, start, end);
  const found: any[] = [];
  let cursor: string | null = null;

  do {
    const data = await gql(admin, ORDERS_QUERY, { q, cursor });
    const conn = data.orders;
    for (const edge of conn.edges) {
      const node = edge.node;
      const orderEmail = (node.email || "").toLowerCase();
      const custEmail = (node.customer?.email || "").toLowerCase();
      // Shopify's email search can be fuzzy — confirm an exact match.
      if (orderEmail === target || custEmail === target) found.push(node);
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);

  return found;
}

/** Find every matching order across all emails, de-duplicated. */
export async function collectMatches(
  admin: Admin,
  emails: string[],
  tag: string,
  start?: string | null,
  end?: string | null,
): Promise<{ matches: OrderMatch[]; notFound: string[] }> {
  const seen = new Set<string>();
  const matches: OrderMatch[] = [];
  const notFound: string[] = [];

  for (const email of emails) {
    const orders = await findOrdersForEmail(admin, email, start, end);
    if (orders.length === 0) {
      notFound.push(email);
      continue;
    }
    for (const o of orders) {
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      const tags: string[] = o.tags || [];
      matches.push({
        id: o.id,
        name: o.name,
        email: o.email || o.customer?.email || "",
        createdAt: o.createdAt,
        fulfillment: o.displayFulfillmentStatus ?? null,
        currentTags: tags,
        alreadyTagged: tags.includes(tag),
      });
    }
  }
  return { matches, notFound };
}

/** Add the tag to each order id. Returns per-order results. */
export async function applyTag(admin: Admin, orderIds: string[], tag: string) {
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const id of orderIds) {
    try {
      const data = await gql(admin, TAGS_ADD, { id, tags: [tag] });
      const errs = data.tagsAdd.userErrors;
      if (errs.length) {
        results.push({ id, ok: false, error: errs.map((e: any) => e.message).join("; ") });
      } else {
        results.push({ id, ok: true });
      }
    } catch (e: any) {
      results.push({ id, ok: false, error: String(e?.message || e) });
    }
  }
  return results;
}
