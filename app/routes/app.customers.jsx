// app/routes/api.customers.jsx

import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const qRaw = url.searchParams.get("q") || "";
  const q = qRaw.trim();

  if (!q || q.length < 2) {
    return new Response(JSON.stringify({ customers: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const response = await admin.graphql(
      `#graphql
      query CustomersSearch($query: String!) {
        customers(first: 10, query: $query) {
          edges {
            node {
              id
              displayName
              email
            }
          }
        }
      }
      `,
      {
        variables: {
          query: q,
        },
      },
    );

    const json = await response.json();

    if (json.errors && json.errors.length > 0) {
      console.error("GraphQL errors in customers search", json.errors);
      return new Response(
        JSON.stringify({ customers: [], error: "GraphQL error" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const edges = json?.data?.customers?.edges || [];
    const customers = edges.map((edge) => {
      const node = edge.node;
      return {
        id: node.id,
        displayName: node.displayName || "",
        email: node.email || "",
      };
    });

    return new Response(JSON.stringify({ customers }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Error searching customers", err);
    return new Response(
      JSON.stringify({ customers: [], error: "Server error" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};
