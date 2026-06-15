import * as XLSX from "xlsx";
import { Buffer } from "node:buffer";

import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  redirect,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

import { useState, useEffect, useRef, useMemo } from "react";

/**
 * Helper: get numeric shop_id from Shopify Admin (shop.id is GID)
 */
async function getShopNumericId(admin) {
  try {
    const resp = await admin.graphql(
      `#graphql
      query {
        shop {
          id
        }
      }
      `,
    );

    let body;
    try {
      if (typeof resp?.json === "function") {
        body = await resp.json();
      } else if (typeof resp?.text === "function") {
        const txt = await resp.text();
        try {
          body = JSON.parse(txt);
        } catch (e) {
          console.error(
            "getShopNumericId: failed to parse response text",
            e,
            txt,
          );
          body = null;
        }
      } else {
        body = resp?.body || resp;
      }
    } catch (err) {
      console.error(
        "getShopNumericId: error reading GraphQL response body",
        err,
      );
      body = null;
    }

    if (body?.errors?.length) {
      console.error("getShopNumericId: GraphQL errors:", body.errors);
    }

    const gid = body?.data?.shop?.id || "";
    const numericId = gid.startsWith("gid://") ? gid.split("/").pop() : gid;

    if (!numericId) {
      console.error(
        "getShopNumericId: missing shop.id in GraphQL data",
        body,
      );
    } else {
      console.log("Detected Shopify numeric shop_id:", numericId);
    }

    return numericId || null;
  } catch (err) {
    console.error("Failed to fetch shop.id for numeric shop_id", err);
    return null;
  }
}

/**
 * Helper: fetch B2B company context for a customer (if any).
 * Returns { companyId, companyLocationId, companyContactId } or all null.
 */
async function getB2BContext(admin, customerGid) {
  if (!customerGid) {
    console.warn("getB2BContext: customerGid is empty, skipping");
    return { companyId: null, companyLocationId: null, companyContactId: null };
  }

  try {
    const resp = await admin.graphql(
      `#graphql
      query B2BContext($id: ID!) {
        customer(id: $id) {
          id
          companyContactProfiles {
            id
            company {
              id
              locations(first: 10) {
                edges {
                  node {
                    id
                    name
                  }
                }
              }
            }
          }
        }
      }`,
      { variables: { id: customerGid } },
    );

    const json = await resp.json();
    console.log("B2B customer GraphQL JSON:", JSON.stringify(json, null, 2));

    const profiles = json?.data?.customer?.companyContactProfiles || [];
    if (!profiles.length) {
      console.log("No companyContactProfiles for customer:", customerGid);
      return { companyId: null, companyLocationId: null, companyContactId: null };
    }

    const profile = profiles[0];

    const companyId = profile?.company?.id || null;
    const companyContactId = profile?.id || null;
    const locEdges = profile?.company?.locations?.edges || [];
    const companyLocationId = locEdges?.[0]?.node?.id || null;

    console.log("B2B context resolved:", {
      customerGid,
      companyId,
      companyContactId,
      companyLocationId,
    });

    return { companyId, companyContactId, companyLocationId };
  } catch (err) {
    console.error("getB2BContext failed:", err);
    return { companyId: null, companyLocationId: null, companyContactId: null };
  }
}

// OC backend endpoint that extracts SKU/quantity pairs from PDF, image, Word or
// pasted text using Claude (mirrors the storefront upload.php ai_extract).
const OC_AI_EXTRACT_URL =
  "https://dev.bloomandgrowgroup.com/index.php?route=bloom/import_order/ai_extract";

// GraphQL selection for a variant + inventory + price. When a B2B company
// location is supplied (withContextual), also pull that location's catalog
// (contextual) price — the same price the storefront shows for the customer.
function variantFields(withContextual) {
  return `
    id
    sku
    displayName
    price
    product { title }
    inventoryItem {
      inventoryLevels(first: 10) {
        edges {
          node {
            quantities(names: ["available"]) {
              name
              quantity
            }
          }
        }
      }
    }
    ${
      withContextual
        ? `contextualPricing(context: { companyLocationId: $loc }) {
             price { amount }
           }`
        : ""
    }
  `;
}

/** Standard preview-row shape used by both the spreadsheet and AI paths. */
function makeParsedRow(sku, quantityRequested) {
  return {
    sku,
    productName: "",
    exist: false,
    availableQuantity: 0,
    quantityRequested,
    fulfilledQuantity: 0,
    status: "pending",
    variantId: null,
  };
}

/**
 * Parse a CSV/Excel file locally with SheetJS. A header row is optional: if the
 * first row looks like headers (sku/product + qty/quantity) those columns are
 * used; otherwise the first row is treated as data with column 1 = SKU and
 * column 2 = quantity. Returns { rows } or { error }.
 */
async function parseSpreadsheet(file) {
  let workbook;
  try {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    workbook = XLSX.read(buffer, { type: "buffer" });
  } catch (e) {
    console.error("Failed to parse file with xlsx", e);
    return {
      error:
        "Unable to read the file. Please check that it's a valid CSV or Excel file.",
    };
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

  if (!rows || rows.length === 0) {
    return { error: "The file is empty." };
  }

  // Optional header detection. Only treat row 1 as a header when it clearly
  // names both an SKU/product and a qty/quantity column — otherwise assume a
  // headerless file (col 1 = SKU, col 2 = quantity) and read every row.
  const firstRow = rows[0].map((h) => String(h).trim().toLowerCase());
  const headerSku = firstRow.findIndex(
    (h) => h.includes("sku") || h.includes("product"),
  );
  const headerQty = firstRow.findIndex(
    (h) => h.includes("qty") || h.includes("quantity"),
  );
  const hasHeader = headerSku !== -1 && headerQty !== -1;

  const skuIndex = hasHeader ? headerSku : 0;
  const qtyIndex = hasHeader ? headerQty : 1;
  const dataRows = hasHeader ? rows.slice(1) : rows;

  const parsed = [];
  for (const row of dataRows) {
    const sku = String(row[skuIndex] || "").trim();
    if (!sku) continue;
    // Strip any non-numeric noise (e.g. "10 pcs") like the PHP CSV parser does.
    const quantityRequested = parseInt(
      String(row[qtyIndex] ?? "").replace(/[^0-9]/g, ""),
      10,
    );
    if (!Number.isFinite(quantityRequested) || quantityRequested <= 0) continue;
    parsed.push(makeParsedRow(sku, quantityRequested));
  }

  return { rows: parsed };
}

/**
 * Send a PDF/image/Word file and/or pasted text to the OC AI extractor and
 * normalise the response into preview rows. Throws on transport/service error.
 */
async function extractRowsWithAI({ file, orderText }) {
  const aiForm = new FormData();
  if (file) aiForm.append("file", file, file.name);
  if (orderText) aiForm.append("order_text", orderText);

  const resp = await fetch(OC_AI_EXTRACT_URL, {
    method: "POST",
    body: aiForm,
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    console.error("AI extract HTTP error:", resp.status, resp.statusText, txt);
    throw new Error(`AI service HTTP ${resp.status}`);
  }

  const json = await resp.json().catch((e) => {
    console.error("AI extract: failed to parse JSON", e);
    return null;
  });

  if (!json) throw new Error("AI service returned an invalid response.");

  const rows = Array.isArray(json.rows) ? json.rows : [];
  if (json.error && rows.length === 0) {
    throw new Error(json.error);
  }

  return rows
    .map((r) => {
      const sku = String(r.sku || "").trim();
      const qty = Number(r.quantity || 0);
      if (!sku || !Number.isFinite(qty) || qty <= 0) return null;
      return makeParsedRow(sku, qty);
    })
    .filter(Boolean);
}

/**
 * Look up a variant by SKU. AI extraction can return a product *name* when no
 * SKU is printed, so fall back to a product title search for multi-word values.
 * When companyLocationId is provided, the returned node includes the catalog
 * (contextual) price for that B2B location.
 */
async function lookupVariantNode(admin, identifier, companyLocationId) {
  const withCtx = !!companyLocationId;
  const fields = variantFields(withCtx);
  const locDecl = withCtx ? ", $loc: ID!" : "";

  // 1) Precise SKU match.
  try {
    const resp = await admin.graphql(
      `#graphql
      query variantBySku($query: String!${locDecl}) {
        productVariants(first: 1, query: $query) {
          edges { node { ${fields} } }
        }
      }`,
      {
        variables: withCtx
          ? { query: `sku:"${identifier}"`, loc: companyLocationId }
          : { query: `sku:"${identifier}"` },
      },
    );
    const json = await resp.json();
    if (json?.errors?.length) {
      console.error("variantBySku errors for", identifier, json.errors);
    }
    const node = json?.data?.productVariants?.edges?.[0]?.node;
    if (node) return node;
  } catch (err) {
    console.error("lookupVariantNode SKU query failed", identifier, err);
  }

  // 2) Fallback: treat a multi-word identifier as a product name.
  if (/\s/.test(identifier)) {
    try {
      const resp = await admin.graphql(
        `#graphql
        query variantByName($query: String!${locDecl}) {
          products(first: 1, query: $query) {
            edges {
              node { variants(first: 1) { edges { node { ${fields} } } } }
            }
          }
        }`,
        {
          variables: withCtx
            ? { query: identifier, loc: companyLocationId }
            : { query: identifier },
        },
      );
      const json = await resp.json();
      if (json?.errors?.length) {
        console.error("variantByName errors for", identifier, json.errors);
      }
      const node =
        json?.data?.products?.edges?.[0]?.node?.variants?.edges?.[0]?.node;
      if (node) return node;
    } catch (err) {
      console.error("lookupVariantNode name query failed", identifier, err);
    }
  }

  return null;
}

/** Resolve the unit price for a variant node — catalog price if present, else base. */
function resolveUnitPrice(variantNode) {
  const ctx = variantNode?.contextualPricing?.price?.amount;
  const ctxPrice = ctx != null ? Number(ctx) : NaN;
  if (Number.isFinite(ctxPrice) && ctxPrice > 0) return ctxPrice;
  const base = Number(variantNode?.price);
  return Number.isFinite(base) ? base : 0;
}

/**
 * Loader: authenticate admin + load history from Prisma (per shopId) + preload customers via OC
 */
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const createdOrderName = url.searchParams.get("createdOrderName") || null;

  const shopDomain = session?.shop || "";
  const shopAdminSubdomain = shopDomain.replace(".myshopify.com", "");

  let shopNumericId = null;
  try {
    shopNumericId = await getShopNumericId(admin);
  } catch (err) {
    console.error("Error resolving shopNumericId in loader", err);
  }

  let history = [];
  if (shopNumericId) {

    // const deleted = await db.bulkOrderUpload.deleteMany({
    //     where: {
    //       shopId: shopNumericId,
    //     },
    //   });

    //   console.log(
    //     "🧹 DEV ONLY: bulkOrderUpload cleared for shop",
    //     shopNumericId,
    //     "rows deleted:",
    //     deleted.count,
    //   );

    try {
      history = await db.bulkOrderUpload.findMany({
        where: {
          shopId: shopNumericId,
        },
        orderBy: { createdAt: "desc" },
        take: 50, // NOTE: client-side pagination will paginate within these 50
      });
    } catch (err) {
      console.error("Error loading bulk import history from Prisma", err);
    }
  } else {
    console.warn("No shopNumericId resolved in loader; skipping history query.");
  }

  let customers = [];
  if (shopNumericId) {
    try {
      const ocResp = await fetch(
        "https://dev.bloomandgrowgroup.com/index.php?route=bloom/import_order/getCustomers",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            shop_id: shopNumericId,
            limit: 250,
          }),
        },
      );

      if (!ocResp.ok) {
        const txt = await ocResp.text();
        console.error(
          "OC getCustomers HTTP error:",
          ocResp.status,
          ocResp.statusText,
          txt,
        );
      }

      const ocJson = await ocResp.json().catch((e) => {
        console.error("OC getCustomers: failed to parse JSON", e);
        return null;
      });

      if (ocJson && ocJson.success) {
        customers = Array.isArray(ocJson.customers) ? ocJson.customers : [];
        console.log("OC customers count:", customers.length);
      } else {
        console.error("OC customers error:", ocJson?.error || "Unknown error", ocJson);
      }
    } catch (err) {
      console.error("Failed to fetch customers from OC:", err);
    }
  }

  return { history, customers, shopAdminSubdomain, createdOrderName };
};

/**
 * Action: handle "process" (preview) and "create" (save + create Draft Order via OC)
 */
export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "process") {
    const customerName = (formData.get("customerName") || "").trim();
    const customerId = (formData.get("customerId") || "").trim();
    const file = formData.get("file");
    const orderText = (formData.get("orderText") || "").trim();

    const missingCustomer = !customerName || !customerId;
    const hasFile = file && typeof file !== "string" && file.size > 0;
    const hasText = orderText.length > 0;

    if (missingCustomer || (!hasFile && !hasText)) {
      const errorMessage =
        "Select a customer and either upload a file (CSV, Excel, PDF, image, or Word) or paste your order text.";
      console.warn("PROCESS validation failed:", {
        missingCustomer,
        hasFile,
        hasText,
        customerName,
        customerId,
      });
      return {
        mode: "error",
        error: errorMessage,
        customerName,
        customerId,
        previewRows: [],
      };
    }

    // Spreadsheets are parsed locally (free + instant). Everything else —
    // PDF, image, Word, or pasted text — goes to the AI extractor.
    const fileExt = hasFile
      ? String(file.name || "").split(".").pop().toLowerCase()
      : "";
    const isSpreadsheet = hasFile && ["csv", "xls", "xlsx"].includes(fileExt);

    let parsedRows = [];

    if (isSpreadsheet) {
      const result = await parseSpreadsheet(file);
      if (result.error) {
        return {
          mode: "error",
          error: result.error,
          customerName,
          customerId,
          previewRows: [],
        };
      }
      parsedRows = result.rows;
    } else {
      try {
        parsedRows = await extractRowsWithAI({
          file: hasFile ? file : null,
          orderText: hasText ? orderText : "",
        });
      } catch (err) {
        console.error("AI extraction failed:", err);
        return {
          mode: "error",
          error:
            "Could not read the upload with AI. " +
            (err.message ||
              "Please try a clearer file or paste the order as text."),
          customerName,
          customerId,
          previewRows: [],
        };
      }
    }

    if (parsedRows.length === 0) {
      console.warn("PROCESS: no valid rows found after parsing");
      return {
        mode: "error",
        error:
          "No valid SKU and quantity pairs were found. Please check the file or pasted text.",
        customerName,
        customerId,
        previewRows: [],
      };
    }

    console.log("PROCESS: parsedRows count:", parsedRows.length);

    // Resolve the customer's B2B company location so the preview can show the
    // catalog price they'll actually be charged (mirrors the storefront).
    const { companyLocationId } = await getB2BContext(admin, customerId);
    console.log("PROCESS: companyLocationId:", companyLocationId || "(none / DTC)");

    const enrichedRows = [];

    for (const row of parsedRows) {
      const sku = row.sku;

      let variantNode = null;
      try {
        variantNode = await lookupVariantNode(admin, sku, companyLocationId);
      } catch (err) {
        console.error(`Error looking up SKU ${sku}`, err);
        enrichedRows.push({
          ...row,
          exist: false,
          productName: "* * * * * * *",
          availableQuantity: 0,
          fulfilledQuantity: 0,
          status: "error",
          variantId: null,
        });
        continue;
      }

      if (!variantNode) {
        enrichedRows.push({
          ...row,
          exist: false,
          productName: "* * * * * * *",
          availableQuantity: 0,
          fulfilledQuantity: 0,
          status: "sku not found",
          variantId: null,
        });
        continue;
      }

      let productName =
        variantNode.displayName || variantNode.product?.title || `SKU ${sku}`;
      productName = productName.replace(" - Default Title", "");

      const levelEdges = variantNode.inventoryItem?.inventoryLevels?.edges || [];
      let totalAvailable = 0;

      for (const edge of levelEdges) {
        const level = edge?.node;
        if (!level) continue;

        const quantities = level.quantities || [];
        const availableEntry = quantities.find((q) => q.name === "available");

        if (availableEntry && typeof availableEntry.quantity === "number") {
          totalAvailable += availableEntry.quantity;
        }
      }

      let fulfilledQuantity = 0;
      let status = "ok";

      if (totalAvailable <= 0) {
        fulfilledQuantity = 0;
        status = "no stock";
      } else if (row.quantityRequested > totalAvailable) {
        fulfilledQuantity = totalAvailable;
        status = "partial";
      } else {
        fulfilledQuantity = row.quantityRequested;
        status = "ok";
      }

      const unitPrice = resolveUnitPrice(variantNode);

      enrichedRows.push({
        ...row,
        exist: true,
        productName,
        availableQuantity: totalAvailable,
        fulfilledQuantity,
        status,
        variantId: variantNode.id,
        unitPrice,
      });
    }

    console.log("PROCESS: enrichedRows count:", enrichedRows.length);

    return {
      mode: "preview",
      customerName,
      customerId,
      previewRows: enrichedRows,
      usingCatalogPrice: !!companyLocationId,
    };
  }

  if (intent === "create") {
    const customerName = formData.get("customerName") || "Unknown Customer";
    const customerIdRaw = formData.get("customerId") || "";
    const previewJson = formData.get("previewJson");

    console.log("CREATE intent: raw customerId from formData:", customerIdRaw);

    const customerGid = customerIdRaw || "";
    const customerNumericId = customerGid.startsWith("gid://")
      ? customerGid.split("/").pop()
      : customerGid;

    const { companyId, companyLocationId, companyContactId } = await getB2BContext(
      admin,
      customerGid,
    );

    const shopNumericId = await getShopNumericId(admin);
    console.log("Detected Shopify numeric shop_id (action):", shopNumericId);

    let previewRows = [];
    if (typeof previewJson === "string" && previewJson.length > 0) {
      try {
        previewRows = JSON.parse(previewJson);
      } catch (e) {
        console.error("Failed to parse previewJson", e, previewJson);
      }
    } else {
      console.warn("CREATE intent: previewJson is empty or not a string");
    }

    const includedRows = previewRows.filter(
      (row) => row.exist && row.variantId && Number(row.fulfilledQuantity || 0) > 0,
    );

    console.log("CREATE intent: includedRows length:", includedRows.length);
    if (includedRows.length === 0) {
      console.warn("CREATE intent: No rows with available inventory to create a draft order");
      return {
        mode: "error",
        error:
          "No rows with available inventory to create a draft order. Please check the preview.",
        customerName,
        customerId: customerIdRaw,
        previewRows,
      };
    }

    const totalQuantity = includedRows.reduce(
      (sum, row) => sum + Number(row.fulfilledQuantity || 0),
      0,
    );

    const lineItems = includedRows.map((row) => ({
      quantity: Number(row.fulfilledQuantity),
      variantId: row.variantId,
    }));

    const note = `Bulk upload for customer: ${customerName} (Shopify customer ID: ${customerNumericId})`;

    console.log("CREATE intent: preparing OC DraftOrderCreate payload:", {
      shopNumericId,
      customerGid,
      customerName,
      totalQuantity,
      lineItemsCount: lineItems.length,
      companyId,
      companyLocationId,
      companyContactId,
    });

    let draftOrder = null;

    try {
      const ocResp = await fetch(
        "https://dev.bloomandgrowgroup.com/index.php?route=bloom/import_order/DraftOrderCreate",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            shop_id: shopNumericId,
            customerId: customerGid,
            customerName: customerName,
            lineItems,
            note,
            totalQuantity,
            companyId,
            companyLocationId,
            companyContactId,
          }),
        },
      );

      if (!ocResp.ok) {
        const debugText = await ocResp.text();
        console.error("OC DraftOrderCreate HTTP error:", ocResp.status, ocResp.statusText, debugText);
        throw new Error(`OC HTTP error ${ocResp.status} ${ocResp.statusText}`);
      }

      let ocJson = null;
      try {
        ocJson = await ocResp.json();
      } catch (e) {
        console.error("OC DraftOrderCreate: failed to parse JSON", e);
        throw new Error("OC DraftOrderCreate: invalid JSON response");
      }

      console.log("OC DraftOrderCreate raw response:", ocJson);

      if (!ocJson || !ocJson.success || !ocJson.draftOrder) {
        console.error("OC DraftOrderCreate: invalid or unsuccessful response", ocJson);
        throw new Error(ocJson?.error || "Invalid response from Shopify GraphQL");
      }

      draftOrder = ocJson.draftOrder;
    } catch (err) {
      console.error("Error calling OC DraftOrderCreate:", err);
      return {
        mode: "error",
        error:
          "Failed to create draft order via external service. " +
          (err.message || "Please check the uploaded data."),
        customerName,
        customerId: customerIdRaw,
        previewRows,
      };
    }

    if (!draftOrder) {
      console.error("CREATE intent: draftOrder is null after OC call");
      return {
        mode: "error",
        error:
          "Failed to create draft order via external service. Please check the uploaded data.",
        customerName,
        customerId: customerIdRaw,
        previewRows,
      };
    }

    const realOrderId = draftOrder.id;
    const realOrderLegacyId = draftOrder.legacyResourceId || "";
    const realOrderName = draftOrder.name || "";

    console.log("Draft order created (via OC):", {
      id: realOrderId,
      legacyId: realOrderLegacyId,
      name: realOrderName,
    });

    try {
      await db.bulkOrderUpload.create({
        data: {
          shopId: shopNumericId || null,
          customerId: customerNumericId,
          customerName,
          orderId: realOrderId,
          orderLegacyId: realOrderLegacyId,
          orderName: realOrderName,
          totalQuantity,
        },
      });
      console.log("BulkOrderUpload saved to Prisma");
    } catch (dbErr) {
      console.error("Error saving bulk upload to Prisma", dbErr);
    }

    const createdOrderNameParam = encodeURIComponent(realOrderName || realOrderLegacyId || realOrderId);
    return redirect(`/app?createdOrderName=${createdOrderNameParam}`);
  }

  return { mode: "idle" };
};

export default function ImportOrdersIndex() {
  const { history, customers, shopAdminSubdomain, createdOrderName } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();

  const isSubmitting = navigation.state === "submitting";
  const inPreviewMode = actionData && actionData.mode === "preview";
  const hasError = !!(actionData && actionData.error);
  const hasSuccess = !!createdOrderName;

  // Customer soft search state (client-side only)
  const [customerQuery, setCustomerQuery] = useState(actionData?.customerName || "");
  const [selectedCustomerId, setSelectedCustomerId] = useState(actionData?.customerId || "");
  const [customerOptions, setCustomerOptions] = useState([]);

  const [previewCancelled, setPreviewCancelled] = useState(false);
  const fileInputRef = useRef(null);

  // Dropzone display state
  const [fileName, setFileName] = useState("");
  const [isDragging, setIsDragging] = useState(false);

  // Editable preview rows (qty edits, row removal, live totals)
  const [editableRows, setEditableRows] = useState([]);

  // ✅ Import History search + pagination (client-side)
  const HISTORY_PAGE_SIZE = 15;
  const [historySearch, setHistorySearch] = useState("");
  const [historyPage, setHistoryPage] = useState(1);

  // ✅ Clear customer + file after successful draft order creation
  useEffect(() => {
    if (hasSuccess) {
      setCustomerQuery("");
      setSelectedCustomerId("");
      setCustomerOptions([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      setFileName("");
    }
  }, [hasSuccess]);

  useEffect(() => {
    setPreviewCancelled(false);
  }, [actionData]);

  // Seed editable preview rows whenever a new preview arrives
  useEffect(() => {
    if (actionData?.mode === "preview" && Array.isArray(actionData.previewRows)) {
      setEditableRows(actionData.previewRows.map((r) => ({ ...r })));
    }
  }, [actionData]);

  // Reset pagination whenever search changes
  useEffect(() => {
    setHistoryPage(1);
  }, [historySearch]);

  const handleCustomerChange = (event) => {
    const value = event.target.value;
    setCustomerQuery(value);
    setSelectedCustomerId("");

    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
      setCustomerOptions([]);
      return;
    }

    const matches = (customers || [])
      .filter((customer) => {
        const name = (customer.displayName || "").toLowerCase();
        const email = (customer.email || "").toLowerCase();
        return name.includes(trimmed) || (email && email.includes(trimmed));
      })
      .slice(0, 10);

    setCustomerOptions(matches);
  };

  const handleCustomerSelect = (customer) => {
    setSelectedCustomerId(customer.id);
    setCustomerQuery(customer.displayName || "");
    setCustomerOptions([]);
  };

  const handleCancelPreview = () => {
    setPreviewCancelled(true);
    setCustomerQuery("");
    setSelectedCustomerId("");
    setCustomerOptions([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    setFileName("");
  };

  const handleFileChange = (event) => {
    const f = event.target.files?.[0];
    setFileName(f ? f.name : "");
  };

  const handleDragOver = (event) => {
    event.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (event) => {
    event.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setIsDragging(false);
    const dropped = event.dataTransfer?.files;
    if (dropped && dropped.length > 0 && fileInputRef.current) {
      fileInputRef.current.files = dropped;
      setFileName(dropped[0].name);
    }
  };

  // Edit requested qty in the preview → recompute fulfilled (capped at available)
  const handleQtyChange = (idx, value) => {
    setEditableRows((prev) =>
      prev.map((row, i) => {
        if (i !== idx) return row;
        const requested = Math.max(1, parseInt(value, 10) || 1);
        const available = Number(row.availableQuantity || 0);
        const fulfilled = available > 0 ? Math.min(available, requested) : 0;
        return { ...row, quantityRequested: requested, fulfilledQuantity: fulfilled };
      }),
    );
  };

  const handleDeleteRow = (idx) => {
    setEditableRows((prev) => prev.filter((_, i) => i !== idx));
  };

  // Subtotal mirrors the storefront: sum of fulfilled × unit (catalog) price
  const previewSubtotal = useMemo(
    () =>
      editableRows.reduce((sum, row) => {
        const unit = Number(row.unitPrice || 0);
        const qty = Number(row.fulfilledQuantity || 0);
        return unit > 0 && qty > 0 ? sum + unit * qty : sum;
      }, 0),
    [editableRows],
  );

  const showPreview = inPreviewMode && !previewCancelled;
  const showHistory = !inPreviewMode || previewCancelled;

  // Search helper for history table
  const normalizedHistorySearch = historySearch.trim().toLowerCase();

  const filteredHistory = useMemo(() => {
    if (!normalizedHistorySearch) return history || [];

    return (history || []).filter((item) => {
      const customerName = String(item.customerName || "").toLowerCase();
      const orderName = String(item.orderName || "").toLowerCase(); // "#61"
      const legacyId = String(item.orderLegacyId || "").toLowerCase();
      const orderId = String(item.orderId || "").toLowerCase();

      return (
        customerName.includes(normalizedHistorySearch) ||
        orderName.includes(normalizedHistorySearch) ||
        legacyId.includes(normalizedHistorySearch) ||
        orderId.includes(normalizedHistorySearch)
      );
    });
  }, [history, normalizedHistorySearch]);

  const totalHistoryRows = filteredHistory.length;
  const totalHistoryPages = Math.max(1, Math.ceil(totalHistoryRows / HISTORY_PAGE_SIZE));

  const safeHistoryPage = Math.min(Math.max(historyPage, 1), totalHistoryPages);

  const pagedHistory = useMemo(() => {
    const start = (safeHistoryPage - 1) * HISTORY_PAGE_SIZE;
    const end = start + HISTORY_PAGE_SIZE;
    return filteredHistory.slice(start, end);
  }, [filteredHistory, safeHistoryPage]);

  const canPrev = safeHistoryPage > 1;
  const canNext = safeHistoryPage < totalHistoryPages;

  return (
    <div style={{ paddingBottom: "30px" }}>
      <s-page heading="Import Orders">
        {/* Upload Form */}
        <s-section>
          <div
            style={{
              marginBottom: "12px",
              borderBottom: "1px solid #ededed",
              paddingBottom: "10px",
            }}
          >
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                background: "#fff4e8",
                color: "#b45309",
                border: "1px solid #ffd9b0",
                borderRadius: "999px",
                padding: "3px 10px",
                fontSize: "11px",
                fontWeight: 700,
                letterSpacing: "0.04em",
                marginBottom: "8px",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 22 22" fill="none" aria-hidden="true">
                <path
                  d="M11 2 12.6 8.4 19 10l-6.4 1.6L11 18l-1.6-6.4L3 10l6.4-1.6L11 2Z"
                  fill="#ff8a1f"
                />
              </svg>
              AI POWERED
            </div>
            <h2 style={{ fontSize: "16px", fontWeight: 600, margin: 0 }}>
              AI Quick Order
            </h2>
          </div>

          {hasError && (
            <div
              className="error-banner"
              style={{
                color: "#721c24",
                backgroundColor: "#f8d7da",
                border: "1px solid #f5c6cb",
                padding: "10px",
                marginBottom: "10px",
                borderRadius: "6px",
              }}
            >
              {actionData.error}
            </div>
          )}

          <div
            style={{
              display: "flex",
              gap: "24px",
              alignItems: "stretch",
              paddingBottom: "10px",
            }}
          >
            <div style={{ flex: "1 1 100%" }}>
              <s-paragraph>
                Select a customer, then upload a file or paste the order. AI
                reads it and finds the SKUs and quantities for you.
              </s-paragraph>

              <Form method="post" encType="multipart/form-data">
                <input type="hidden" name="intent" value="process" />

                <s-box paddingBlockEnd="base">
                  <label
                    style={{
                      display: "block",
                      marginBottom: "0.25rem",
                      fontWeight: 500,
                      marginTop: "15px",
                    }}
                  >
                    Customer
                  </label>
                  <input
                    type="text"
                    name="customerName"
                    placeholder="Start typing customer name..."
                    value={customerQuery}
                    autoComplete="off"
                    onChange={handleCustomerChange}
                    style={{
                      width: "100%",
                      padding: "0.5rem 0.75rem",
                      borderRadius: "8px",
                      border: "1px solid #8c9196",
                      fontSize: "14px",
                      boxSizing: "border-box",
                    }}
                  />

                  <input type="hidden" name="customerId" value={selectedCustomerId} />

                  {customerOptions.length > 0 && (
                    <div
                      style={{
                        marginTop: "4px",
                        width: "50%",
                        border: "1px solid #c9cccf",
                        borderRadius: "8px",
                        backgroundColor: "#ffffff",
                        maxHeight: "220px",
                        overflowY: "auto",
                        boxShadow:
                          "0 4px 8px rgba(0,0,0,0.04), 0 0 0 1px rgba(0,0,0,0.02)",
                        zIndex: 10,
                        position: "relative",
                      }}
                    >
                      {customerOptions.map((customer) => (
                        <div
                          key={customer.id}
                          onClick={() => handleCustomerSelect(customer)}
                          style={{
                            padding: "6px 10px",
                            cursor: "pointer",
                            borderBottom: "1px solid #f0f1f2",
                            backgroundColor:
                              customer.id === selectedCustomerId ? "#f2f7ff" : "#ffffff",
                          }}
                        >
                          <div style={{ fontSize: "14px", fontWeight: 500 }}>
                            {customer.displayName}
                          </div>
                          {customer.email && (
                            <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "2px" }}>
                              {customer.email}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </s-box>

                <s-box paddingBlockEnd="base">
                  <div
                    style={{
                      display: "flex",
                      gap: "16px",
                      alignItems: "stretch",
                      flexWrap: "wrap",
                    }}
                  >
                    {/* Left: file dropzone */}
                    <div style={{ flex: "1 1 280px", minWidth: 0 }}>
                      <label
                        style={{
                          display: "block",
                          marginBottom: "0.25rem",
                          fontWeight: 500,
                        }}
                      >
                        Upload your file
                      </label>
                      <label
                        htmlFor="import-file-input"
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
                        style={{
                          minHeight: "168px",
                          border: isDragging
                            ? "2px dashed #ff8a1f"
                            : "1px dashed #aab0b6",
                          background: isDragging ? "#fff7ef" : "#fafbfb",
                          borderRadius: "10px",
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          justifyContent: "center",
                          textAlign: "center",
                          padding: "18px",
                          cursor: "pointer",
                          boxSizing: "border-box",
                        }}
                      >
                        <svg
                          width="56"
                          height="46"
                          viewBox="0 0 68 54"
                          fill="none"
                          aria-hidden="true"
                        >
                          <path
                            d="M50 21.5C48.6 13.9 42 8.5 34 8.5c-6.3 0-11.8 3.6-14.6 8.9C13.3 18 8 23.8 8 30.9 8 38.2 13.8 44 21 44h26c6.6 0 12-5.4 12-12a12 12 0 0 0-9-11.5Z"
                            fill="#f0f2f5"
                            stroke="#d1d5db"
                            strokeWidth="1.5"
                          />
                          <path
                            d="M34 38V26"
                            stroke="#9ca3af"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                          />
                          <path
                            d="M27 32l7-7 7 7"
                            stroke="#9ca3af"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                        {fileName ? (
                          <strong
                            style={{
                              fontSize: "13px",
                              color: "#1f2024",
                              marginTop: "10px",
                              wordBreak: "break-all",
                            }}
                          >
                            {fileName}
                          </strong>
                        ) : (
                          <>
                            <strong
                              style={{
                                fontSize: "13px",
                                fontWeight: 600,
                                marginTop: "10px",
                              }}
                            >
                              Drag and drop your file here
                            </strong>
                            <span
                              style={{
                                fontSize: "13px",
                                color: "#6d7175",
                                marginTop: "4px",
                              }}
                            >
                              or click to browse
                            </span>
                          </>
                        )}
                        <small
                          style={{
                            fontSize: "11px",
                            color: "#8c9196",
                            marginTop: "10px",
                          }}
                        >
                          CSV, Excel, PDF, JPG, PNG, WEBP, DOC, DOCX
                        </small>
                      </label>
                      <input
                        id="import-file-input"
                        type="file"
                        name="file"
                        ref={fileInputRef}
                        onChange={handleFileChange}
                        accept=".csv, .xls, .xlsx, .pdf, .doc, .docx, .jpg, .jpeg, .png, .webp, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel, application/pdf, image/jpeg, image/png, image/webp"
                        style={{ display: "none" }}
                      />
                    </div>

                    {/* Right: paste / type */}
                    <div style={{ flex: "1 1 280px", minWidth: 0 }}>
                      <label
                        style={{
                          display: "block",
                          marginBottom: "0.25rem",
                          fontWeight: 500,
                        }}
                      >
                        Or paste / type your order
                      </label>
                      <textarea
                        name="orderText"
                        placeholder={
                          "Paste SKUs and quantities, one per line\nor separated by commas\n\ne.g. BC-001, 10\nGentle Baby Lotion 250ml x 3"
                        }
                        style={{
                          width: "100%",
                          minHeight: "168px",
                          padding: "14px",
                          borderRadius: "10px",
                          border: "1px solid #8c9196",
                          fontSize: "13px",
                          lineHeight: 1.5,
                          boxSizing: "border-box",
                          fontFamily: "inherit",
                          resize: "vertical",
                        }}
                      />
                    </div>
                  </div>
                </s-box>

                <button
                  type="submit"
                  disabled={isSubmitting}
                  style={{
                    backgroundColor: "#000000",
                    color: "#ffffff",
                    border: "none",
                    borderRadius: "8px",
                    padding: "0.5rem 1.25rem",
                    fontSize: "14px",
                    cursor: isSubmitting ? "default" : "pointer",
                    opacity: isSubmitting ? 0.7 : 1,
                  }}
                >
                  {isSubmitting ? "Processing…" : "Preview order"}
                </button>
              </Form>
            </div>
          </div>
        </s-section>

        {showPreview && (
          <s-section>
            <h2
              style={{
                fontSize: "16px",
                fontWeight: 600,
                marginBottom: "12px",
                borderBottom: "1px solid #ededed",
                paddingBottom: "10px",
              }}
            >
              Preview
            </h2>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "8px",
                gap: "16px",
              }}
            >
              <s-paragraph>
                Review and adjust quantities before creating the order. Only
                existing SKUs with available inventory are added.
              </s-paragraph>
              <span
                style={{ fontSize: "13px", color: "#6d7175", whiteSpace: "nowrap" }}
              >
                <strong>{editableRows.length}</strong>{" "}
                item{editableRows.length === 1 ? "" : "s"}
              </span>
            </div>

            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <table width="100%" cellPadding={6} style={{ borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>SKU</th>
                    <th style={{ textAlign: "left" }}>Product</th>
                    <th style={{ textAlign: "left", width: "110px" }}>Requested</th>
                    <th style={{ textAlign: "left" }}>Available</th>
                    <th style={{ textAlign: "left" }}>Fulfilled Qty</th>
                    <th style={{ textAlign: "left" }}>Total Price</th>
                    <th style={{ width: "40px" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {editableRows.map((row, idx) => {
                    const isNotFound = row.status === "sku not found" || row.status === "error";
                    const isNoStock = row.status === "no stock";

                    let textColor = "#000000";
                    if (isNotFound) textColor = "#ff0000";
                    else if (isNoStock) textColor = "#aaaaaa";

                    const backgroundColor = idx % 2 === 0 ? "#ffffff" : "#f7f7f7";

                    const unit = Number(row.unitPrice || 0);
                    const fulfilled = Number(row.fulfilledQuantity || 0);
                    const lineTotal = unit > 0 && fulfilled > 0 ? unit * fulfilled : 0;

                    return (
                      <tr key={idx} style={{ backgroundColor, color: textColor }}>
                        <td style={{ textAlign: "left" }}>{row.sku}</td>
                        <td style={{ textAlign: "left" }}>
                          {row.productName || "* * * * * * *"}
                        </td>
                        <td style={{ textAlign: "left" }}>
                          <input
                            type="number"
                            min="1"
                            value={row.quantityRequested}
                            onChange={(e) => handleQtyChange(idx, e.target.value)}
                            disabled={isNotFound}
                            style={{
                              width: "70px",
                              padding: "4px 6px",
                              border: "1px solid #c9cccf",
                              borderRadius: "6px",
                              fontSize: "13px",
                              textAlign: "center",
                            }}
                          />
                        </td>
                        <td style={{ textAlign: "left" }}>{row.availableQuantity}</td>
                        <td style={{ textAlign: "left" }}>{fulfilled}</td>
                        <td style={{ textAlign: "left" }}>
                          {lineTotal > 0 ? "$" + lineTotal.toFixed(2) : "–"}
                        </td>
                        <td style={{ textAlign: "center" }}>
                          <button
                            type="button"
                            onClick={() => handleDeleteRow(idx)}
                            aria-label="Remove row"
                            style={{
                              background: "transparent",
                              border: "none",
                              cursor: "pointer",
                              color: "#999",
                              fontSize: "18px",
                              lineHeight: 1,
                            }}
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  alignItems: "center",
                  gap: "24px",
                  marginTop: "14px",
                  paddingTop: "12px",
                  borderTop: "1px solid #e1e1e1",
                }}
              >
                <span style={{ fontSize: "13px", color: "#444" }}>
                  Subtotal (ex GST)
                </span>
                <strong style={{ fontSize: "15px" }}>
                  ${previewSubtotal.toFixed(2)}
                </strong>
              </div>
            </s-box>

            {actionData.usingCatalogPrice ? (
              <s-paragraph>
                <s-text tone="subdued">
                  Prices shown are this customer&apos;s B2B catalog price for
                  their company location. The draft order will use the same
                  catalog pricing.
                </s-text>
              </s-paragraph>
            ) : (
              <s-paragraph>
                <s-text tone="subdued">
                  This customer has no B2B company location, so standard product
                  prices are shown.
                </s-text>
              </s-paragraph>
            )}

            <div style={{ marginTop: "20px" }}>
              <s-box style={{ marginTop: "20px", textAlign: "center" }}>
                <s-stack direction="inline" gap="base" style={{ justifyContent: "center" }}>
                  <Form method="post">
                    <input type="hidden" name="intent" value="create" />
                    <input type="hidden" name="customerName" value={actionData.customerName || ""} />
                    <input type="hidden" name="customerId" value={actionData.customerId || ""} />
                    <input type="hidden" name="previewJson" value={JSON.stringify(editableRows)} />

                    <s-button type="submit" variant="primary" {...(isSubmitting ? { loading: true } : {})}>
                      <span style={{ display: "inline-block", padding: "3px 5px", fontSize: "14px" }}>
                        Confirm & create order
                      </span>
                    </s-button>
                  </Form>

                  <s-button
                    variant="secondary"
                    onClick={handleCancelPreview}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "#005bd3",
                      padding: 0,
                      minHeight: "auto",
                    }}
                  >
                    <span style={{ display: "inline-block", padding: "3px 5px", fontSize: "14px" }}>
                      Cancel
                    </span>
                  </s-button>
                </s-stack>
              </s-box>
            </div>
          </s-section>
        )}

        {showHistory && (
          <s-section>
            <h2
              style={{
                fontSize: "16px",
                fontWeight: 600,
                marginBottom: "12px",
                borderBottom: "1px solid #ededed",
                paddingBottom: "10px",
              }}
            >
              Import history
            </h2>

            {hasSuccess && (
              <div
                style={{
                  color: "#155724",
                  backgroundColor: "#d4edda",
                  border: "1px solid #c3e6cb",
                  padding: "10px",
                  marginBottom: "10px",
                  borderRadius: "6px",
                }}
              >
                The draft order {createdOrderName} has been successfully created.
              </div>
            )}

            {/* ✅ Search + Pagination controls */}
            <div
              style={{
                display: "flex",
                gap: "12px",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "10px",
              }}
            >
              <div style={{ flex: "1 1 auto" }}>
                <input
                  type="text"
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                  placeholder='Search customer, company or order number'
                  style={{
                    width: "100%",
                    maxWidth: "520px",
                    padding: "0.5rem 0.75rem",
                    borderRadius: "8px",
                    border: "1px solid #8c9196",
                    fontSize: "14px",
                    boxSizing: "border-box",
                  }}
                />
              </div>

              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <span style={{ fontSize: "13px", color: "#6d7175" }}>
                  Page {safeHistoryPage} of {totalHistoryPages}
                </span>

                <button
                  type="button"
                  onClick={() => canPrev && setHistoryPage((p) => Math.max(1, p - 1))}
                  disabled={!canPrev}
                  style={{
                    backgroundColor: "#ffffff",
                    border: "1px solid #c9cccf",
                    borderRadius: "8px",
                    padding: "6px 10px",
                    fontSize: "13px",
                    cursor: canPrev ? "pointer" : "default",
                    opacity: canPrev ? 1 : 0.5,
                  }}
                >
                  Prev
                </button>

                <button
                  type="button"
                  onClick={() => canNext && setHistoryPage((p) => Math.min(totalHistoryPages, p + 1))}
                  disabled={!canNext}
                  style={{
                    backgroundColor: "#ffffff",
                    border: "1px solid #c9cccf",
                    borderRadius: "8px",
                    padding: "6px 10px",
                    fontSize: "13px",
                    cursor: canNext ? "pointer" : "default",
                    opacity: canNext ? 1 : 0.5,
                  }}
                >
                  Next
                </button>
              </div>
            </div>

            {filteredHistory.length === 0 ? (
              <s-paragraph>No bulk imports yet.</s-paragraph>
            ) : (
              <>
                <div style={{ marginBottom: "8px", fontSize: "13px", color: "#6d7175" }}>
                  Showing{" "}
                  {totalHistoryRows === 0
                    ? 0
                    : (safeHistoryPage - 1) * HISTORY_PAGE_SIZE + 1}{" "}
                  –{" "}
                  {Math.min(safeHistoryPage * HISTORY_PAGE_SIZE, totalHistoryRows)} of{" "}
                  {totalHistoryRows}
                </div>

                <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
                  <table width="100%" cellPadding={6} style={{ borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left" }}>Customer</th>
                        <th style={{ textAlign: "left" }}>Order (Draft)</th>
                        <th style={{ textAlign: "left" }}>Total Qty</th>
                        <th style={{ textAlign: "left" }}>Created At</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedHistory.map((item, idx) => {
                        const isOddRow = idx % 2 === 0;
                        const backgroundColor = isOddRow ? "#ffffff" : "#f7f7f7";

                        return (
                          <tr key={item.id} style={{ backgroundColor }}>
                            <td style={{ textAlign: "left" }}>
                              {shopAdminSubdomain && item.customerId ? (
                                <a
                                  href={`https://admin.shopify.com/store/${shopAdminSubdomain}/customers/${item.customerId}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  style={{ color: "#005bd3", textDecoration: "underline" }}
                                >
                                  {item.customerName}
                                </a>
                              ) : (
                                item.customerName
                              )}
                            </td>
                            <td style={{ textAlign: "left" }}>
                              {shopAdminSubdomain && item.orderLegacyId ? (
                                <a
                                  href={`https://admin.shopify.com/store/${shopAdminSubdomain}/draft_orders/${item.orderLegacyId}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  style={{ color: "#005bd3", textDecoration: "underline" }}
                                >
                                  {item.orderName || item.orderLegacyId || item.orderId}
                                </a>
                              ) : (
                                item.orderName || item.orderLegacyId || item.orderId
                              )}
                            </td>
                            <td style={{ textAlign: "left" }}>{item.totalQuantity}</td>
                            <td style={{ textAlign: "left" }}>
                              {new Date(item.createdAt).toLocaleString("en-AU", {
                                dateStyle: "medium",
                                timeStyle: "short",
                              })}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </s-box>
              </>
            )}
          </s-section>
        )}
      </s-page>
    </div>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
