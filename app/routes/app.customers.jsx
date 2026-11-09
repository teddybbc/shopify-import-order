// app/routes/app.customers.jsx  →  GET /app/customers?q=...
//
// Customer search for the Import Order picker. Reads straight from Shopify
// (customers + B2B companies), so it no longer depends on the retired
// dev.bloomandgrowgroup.com getCustomers endpoint.

import { authenticate } from "../shopify.server";

const SEARCH_QUERY = `#graphql
  query CustomerPickerSearch($query: String!) {
    customers(first: 10, query: $query) {
      nodes {
        id
        displayName
        defaultEmailAddress { emailAddress }
        companyContactProfiles { company { name } }
      }
    }
    companies(first: 10, query: $query) {
      nodes {
        name
        contacts(first: 5) {
          nodes {
            customer {
              id
              displayName
              defaultEmailAddress { emailAddress }
            }
          }
        }
      }
    }
  }
`;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const q = (new URL(request.url).searchParams.get("q") || "").trim();
  if (q.length < 2) return json({ customers: [] });

  try {
    const response = await admin.graphql(SEARCH_QUERY, {
      variables: { query: q },
    });
    const body = await response.json();

    if (body.errors?.length) {
      console.error("GraphQL errors in customer search", body.errors);
      return json({ customers: [], error: "GraphQL error" }, 500);
    }

    // Merge customers found directly with contacts of matching companies,
    // de-duplicated by customer id. Company matches come first because B2B
    // staff usually type the shop/company name.
    const byId = new Map();
    const add = (customer, companyName) => {
      if (!customer?.id || byId.has(customer.id)) return;
      byId.set(customer.id, {
        id: customer.id,
        displayName: customer.displayName || "",
        email: customer.defaultEmailAddress?.emailAddress || "",
        companyName: companyName || "",
      });
    };

    for (const company of body?.data?.companies?.nodes || []) {
      for (const contact of company.contacts?.nodes || []) {
        add(contact.customer, company.name);
      }
    }
    for (const customer of body?.data?.customers?.nodes || []) {
      add(customer, customer.companyContactProfiles?.[0]?.company?.name);
    }

    return json({ customers: Array.from(byId.values()).slice(0, 15) });
  } catch (err) {
    console.error("Error searching customers", err);
    return json({ customers: [], error: "Server error" }, 500);
  }
};
