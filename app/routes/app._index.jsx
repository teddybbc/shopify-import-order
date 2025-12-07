// app/routes/app._index.jsx
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

import { useState, useEffect, useRef } from "react";

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
    if (typeof resp?.json === "function") {
      body = await resp.json();
    } else {
      body = resp?.body || resp;
    }

    const gid = body?.data?.shop?.id || "";
    const numericId = gid.startsWith("gid://")
      ? gid.split("/").pop()
      : gid;

    console.log("Detected Shopify numeric shop_id:", numericId);
    return numericId || null;
  } catch (err) {
    console.error("Failed to fetch shop.id for numeric shop_id", err);
    return null;
  }
}

/**
 * Loader: authenticate admin + load history from Prisma (per shopId) + preload customers via OC
 */
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const createdOrderName = url.searchParams.get("createdOrderName") || null;

  // Shopify admin subdomain for building admin links
  const shopDomain = session?.shop || ""; // e.g. "dev02-bloom-connect.myshopify.com"
  const shopAdminSubdomain = shopDomain.replace(".myshopify.com", "");

  // Resolve numeric shop_id once
  let shopNumericId = null;
  try {
    shopNumericId = await getShopNumericId(admin);
  } catch (err) {
    console.error("Error resolving shopNumericId in loader", err);
  }

  // Load import history from Prisma, filtered by this shopId
  let history = [];
  if (shopNumericId) {
    try {
      history = await db.bulkOrderUpload.findMany({
        where: {
          shopId: shopNumericId,
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
    } catch (err) {
      console.error("Error loading bulk import history from Prisma", err);
    }
  } else {
    console.warn(
      "No shopNumericId resolved in loader; skipping history query.",
    );
  }

  // Fetch customers via OC external endpoint
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
            limit: 250, // ask for up to 250 customers (OC side can paginate further if needed)
          }),
        },
      );

      const ocJson = await ocResp.json();

      if (ocJson && ocJson.success) {
        customers = Array.isArray(ocJson.customers)
          ? ocJson.customers
          : [];
        console.log("OC customers count:", customers.length);
      } else {
        console.error(
          "OC customers error:",
          ocJson?.error || "Unknown error",
        );
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
  const { admin } = await authenticate.admin(request); // Admin API client
  const formData = await request.formData();
  const intent = formData.get("intent");

  // ─────────────────────────────────────────────────────────────
  // 1) PROCESS: Parse file, enrich rows with Shopify data
  // ─────────────────────────────────────────────────────────────
  if (intent === "process") {
    const customerNameRaw = formData.get("customerName") || "";
    const customerIdRaw = formData.get("customerId") || "";
    const customerName = customerNameRaw.trim();
    const customerId = customerIdRaw.trim();
    const file = formData.get("file");

    // 🔴 Frontline validation: customer + file required
    const missingCustomer = !customerName || !customerId;
    const missingFile = !file || typeof file === "string";

    if (missingCustomer || missingFile) {
      let errorMessage =
        "Customer selection and CSV/Excel file are required to import orders.";
      return {
        mode: "error",
        error: errorMessage,
        customerName,
        customerId,
        previewRows: [],
      };
    }

    // Read file into a Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Parse using xlsx (works for .csv and .xlsx)
    let workbook;
    try {
      workbook = XLSX.read(buffer, { type: "buffer" });
    } catch (e) {
      console.error("Failed to parse file with xlsx", e);
      return {
        mode: "error",
        error:
          "Unable to read the file. Please check that it's a valid CSV or Excel file.",
        customerName,
        customerId,
        previewRows: [],
      };
    }

    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    // Convert to array-of-arrays: [ [header1, header2, ...], [row1col1, ...], ... ]
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
    });

    if (!rows || rows.length === 0) {
      return {
        mode: "error",
        error: "The file is empty.",
        customerName,
        customerId,
        previewRows: [],
      };
    }

    // First row is the header: find sku + quantity columns (case-insensitive)
    const headerRow = rows[0].map((h) => String(h).trim().toLowerCase());
    const skuIndex = headerRow.findIndex((h) => h === "sku");
    const qtyIndex = headerRow.findIndex(
      (h) => h === "quantity" || h === "qty",
    );

    if (skuIndex === -1 || qtyIndex === -1) {
      return {
        mode: "error",
        error:
          "Header row must contain 'sku' and 'quantity' (or 'qty') columns.",
        customerName,
        customerId,
        previewRows: [],
      };
    }

    // Build base preview rows from data rows
    const dataRows = rows.slice(1);
    const parsedRows = [];

    for (const row of dataRows) {
      const rawSku = row[skuIndex];
      const rawQty = row[qtyIndex];

      const sku = String(rawSku || "").trim();
      if (!sku) {
        // skip blank SKU rows
        continue;
      }

      const quantityRequested = Number(rawQty || 0);
      if (!Number.isFinite(quantityRequested) || quantityRequested <= 0) {
        // skip non-positive or invalid quantities
        continue;
      }

      parsedRows.push({
        sku,
        productName: "", // will fill from Shopify
        exist: false, // kept in data model, but not shown as a column anymore
        availableQuantity: 0, // will update later
        quantityRequested,
        fulfilledQuantity: 0, // will compute later
        status: "pending", // placeholder
        variantId: null, // needed later for draft order
      });
    }

    if (parsedRows.length === 0) {
      return {
        mode: "error",
        error:
          "No valid rows found. Please check that SKU and Quantity columns are filled.",
        customerName,
        customerId,
        previewRows: [],
      };
    }

    // Enrich each row with Shopify data: variant + inventory
    const enrichedRows = [];

    for (const row of parsedRows) {
      const sku = row.sku;

      try {
        const response = await admin.graphql(
          `#graphql
          query variantBySku($query: String!) {
            productVariants(first: 1, query: $query) {
              edges {
                node {
                  id
                  sku
                  displayName
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
                }
              }
            }
          }
          `,
          {
            variables: {
              // safer to quote the SKU in the search query
              query: `sku:"${sku}"`,
            },
          },
        );

        const json = await response.json();

        // If GraphQL returned errors (but client didn't throw), treat as API error
        if (json.errors && json.errors.length > 0) {
          console.error("GraphQL errors for SKU", sku, json.errors);
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

        const edges = json?.data?.productVariants?.edges || [];
        const variantNode = edges.length > 0 ? edges[0].node : null;

        if (!variantNode) {
          // SKU not found in Shopify
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
          variantNode.displayName ||
          variantNode.product?.title ||
          `SKU ${sku}`;

        // strip " - Default Title" if present
        productName = productName.replace(" - Default Title", "");

        // Sum "available" across inventory levels using quantities()
        const levelEdges =
          variantNode.inventoryItem?.inventoryLevels?.edges || [];

        let totalAvailable = 0;

        for (const edge of levelEdges) {
          const level = edge?.node;
          if (!level) continue;

          const quantities = level.quantities || [];
          const availableEntry = quantities.find(
            (q) => q.name === "available",
          );

          if (
            availableEntry &&
            typeof availableEntry.quantity === "number"
          ) {
            totalAvailable += availableEntry.quantity;
          }
        }

        let availableQuantity = totalAvailable;
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

        enrichedRows.push({
          ...row,
          exist: true,
          productName,
          availableQuantity,
          fulfilledQuantity,
          status,
          variantId: variantNode.id,
        });
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
      }
    }

    return {
      mode: "preview",
      customerName,
      customerId,
      previewRows: enrichedRows,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // 2) CREATE: Save history + create Draft Order via OC
  // ─────────────────────────────────────────────────────────────
  if (intent === "create") {
    const customerName = formData.get("customerName") || "Unknown Customer";
    const customerIdRaw = formData.get("customerId") || "";
    const previewJson = formData.get("previewJson");

    // ➜ customerGid = full Shopify GID (needed for GraphQL `customerId`)
    const customerGid = customerIdRaw || "";

    // ➜ customerNumericId = numeric part (for Prisma + links + note)
    const customerNumericId = customerGid.startsWith("gid://")
      ? customerGid.split("/").pop()
      : customerGid;

    // Get numeric shop_id again for OC and for Prisma shopId
    const shopNumericId = await getShopNumericId(admin);
    console.log(
      "Detected Shopify numeric shop_id (action):",
      shopNumericId,
    );

    let previewRows = [];
    if (typeof previewJson === "string" && previewJson.length > 0) {
      try {
        previewRows = JSON.parse(previewJson);
      } catch (e) {
        console.error("Failed to parse previewJson", e);
      }
    }

    // Only include rows that will actually be added to the order
    const includedRows = previewRows.filter(
      (row) =>
        row.exist &&
        row.variantId &&
        Number(row.fulfilledQuantity || 0) > 0,
    );

    if (includedRows.length === 0) {
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

    // Call OC DraftOrderCreate endpoint
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
            // 🔑 IMPORTANT: send full GID to OC for GraphQL customerId
            customerId: customerGid,
            customerName: customerName, // not used by OC but harmless
            lineItems,                   // camelCase to match PHP
            note,
            totalQuantity,
          }),
        },
      );

      if (!ocResp.ok) {
        // For debugging, grab the raw body too
        const debugText = await ocResp.text();
        console.error(
          "OC DraftOrderCreate HTTP error:",
          ocResp.status,
          debugText,
        );
        throw new Error(
          `OC HTTP error ${ocResp.status} ${ocResp.statusText}`,
        );
      }

      const ocJson = await ocResp.json();
      console.log("OC DraftOrderCreate raw response:", ocJson);

      if (!ocJson || !ocJson.success || !ocJson.draftOrder) {
        throw new Error(
          ocJson?.error || "Invalid response from Shopify GraphQL",
        );
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

    // Save a simple history row in Prisma (scoped by shopId)
    try {
      await db.bulkOrderUpload.create({
        data: {
          shopId: shopNumericId || null, // ← NEW: per-domain history
          customerId: customerNumericId, // numeric customer id
          customerName,
          orderId: realOrderId, // full GID
          orderLegacyId: realOrderLegacyId, // numeric draft order id
          orderName: realOrderName, // e.g. "#24"
          totalQuantity,
        },
      });
      console.log("BulkOrderUpload saved to Prisma");
    } catch (dbErr) {
      console.error("Error saving bulk upload to Prisma", dbErr);
      // We don't stop the redirect if the draft order is created – history is "nice to have".
    }

    // Redirect back to /app with a success flag so loader shows success banner
    const createdOrderNameParam = encodeURIComponent(
      realOrderName || realOrderLegacyId || realOrderId,
    );
    return redirect(`/app?createdOrderName=${createdOrderNameParam}`);
  }

  // default: nothing special
  return { mode: "idle" };
};

export default function ImportOrdersIndex() {
  const { history, customers, shopAdminSubdomain, createdOrderName } =
    useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();

  const isSubmitting = navigation.state === "submitting";
  const inPreviewMode = actionData && actionData.mode === "preview";
  const hasError = !!(actionData && actionData.error);
  const hasSuccess = !!createdOrderName;

  // ─────────────────────────────────────────────────────────────
  // Customer soft search state (client-side only, using preloaded customers from OC)
  // ─────────────────────────────────────────────────────────────
  const [customerQuery, setCustomerQuery] = useState(
    actionData?.customerName || "",
  );
  const [selectedCustomerId, setSelectedCustomerId] = useState(
    actionData?.customerId || "",
  );
  const [customerOptions, setCustomerOptions] = useState([]);

  // Local override to hide preview after Cancel
  const [previewCancelled, setPreviewCancelled] = useState(false);

  // File input ref so we can clear it on success / cancel
  const fileInputRef = useRef(null);

  // ✅ Clear customer + file after successful draft order creation
  useEffect(() => {
    if (hasSuccess) {
      setCustomerQuery("");
      setSelectedCustomerId("");
      setCustomerOptions([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }, [hasSuccess]);

  // ✅ Whenever actionData changes (new preview / error), reset previewCancelled
  useEffect(() => {
    setPreviewCancelled(false);
  }, [actionData]);

  const handleCustomerChange = (event) => {
    const value = event.target.value;
    setCustomerQuery(value);
    setSelectedCustomerId(""); // reset selection on manual typing

    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
      setCustomerOptions([]);
      return;
    }

    const matches = (customers || [])
      .filter((customer) => {
        const name = (customer.displayName || "").toLowerCase();
        const email = (customer.email || "").toLowerCase();
        return (
          name.includes(trimmed) ||
          (email && email.includes(trimmed))
        );
      })
      .slice(0, 10);

    setCustomerOptions(matches);
  };

  const handleCustomerSelect = (customer) => {
    setSelectedCustomerId(customer.id);
    setCustomerQuery(customer.displayName || "");
    setCustomerOptions([]);
  };

  // 🔹 Cancel in Preview: hide preview, show history, clear inputs + file
  const handleCancelPreview = () => {
    setPreviewCancelled(true);
    setCustomerQuery("");
    setSelectedCustomerId("");
    setCustomerOptions([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  // Derived flags for rendering
  const showPreview = inPreviewMode && !previewCancelled;
  const showHistory = !inPreviewMode || previewCancelled;

  return (
    <div style={{ paddingBottom: "30px" }}>
      <s-page heading="Import Orders">
        {/* Upload Form */}
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
            Bulk Order Upload
          </h2>

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

          {/* Two-column layout: left = form, right = format image */}
          <div
            style={{
              display: "flex",
              gap: "24px",
              alignItems: "stretch",
              paddingBottom: "10px",
            }}
          >
            {/* LEFT 50%: existing upload form */}
            <div style={{ flex: "1 1 50%" }}>
              <s-paragraph>
                Select a customer and upload a CSV/Excel file with{" "}
                <s-text as="span" emphasis="bold">
                  sku
                </s-text>{" "}
                and{" "}
                <s-text as="span" emphasis="bold">
                  quantity
                </s-text>
                .
              </s-paragraph>

              <Form method="post" encType="multipart/form-data">
                <input type="hidden" name="intent" value="process" />

                {/* Customer input with soft search (local, from OC) */}
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
                    autocomplete="off"
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
                  {/* Hidden field that actually carries the Shopify customer GID */}
                  <input
                    type="hidden"
                    name="customerId"
                    value={selectedCustomerId}
                  />

                  {/* Suggestions dropdown (local search) */}
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
                              customer.id === selectedCustomerId
                                ? "#f2f7ff"
                                : "#ffffff",
                          }}
                        >
                          <div
                            style={{ fontSize: "14px", fontWeight: 500 }}
                          >
                            {customer.displayName}
                          </div>
                          {customer.email && (
                            <div
                              style={{
                                fontSize: "12px",
                                color: "#6d7175",
                                marginTop: "2px",
                              }}
                            >
                              {customer.email}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </s-box>

                <s-box paddingBlockEnd="base">
                  <label
                    style={{ display: "block", marginBottom: "0.25rem" }}
                  >
                    Import file (CSV or Excel)
                  </label>
                  <input
                    type="file"
                    name="file"
                    ref={fileInputRef}
                    accept=".csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel"
                  />
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
                  {isSubmitting ? "Processing..." : "Process file"}
                </button>
              </Form>
            </div>

            {/* RIGHT 50%: "Format" label + centered image */}
            <div
              style={{
                flex: "1 1 50%",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  fontWeight: 600,
                  marginBottom: "8px",
                  fontSize: "14px",
                }}
              >
                Format
              </div>
              <img
                src="https://bloomconnect.com.au/cdn/shop/t/13/assets/upload_order_csv.png?v=116619409245202095531739495015"
                alt="CSV upload format example"
                style={{
                  width: "160px",
                  height: "140px",
                  objectFit: "contain",
                  display: "block",
                }}
              />
            </div>
          </div>
        </s-section>

        {/* Preview section — shown instead of history while in preview mode */}
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
            <s-paragraph>
              Review the items before creating the order. Only existing SKUs
              with available inventory will be added.
            </s-paragraph>

            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <table
                width="100%"
                cellPadding={6}
                style={{ borderCollapse: "collapse" }}
              >
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>SKU</th>
                    <th style={{ textAlign: "left" }}>Product Name</th>
                    <th style={{ textAlign: "left" }}>Available</th>
                    <th style={{ textAlign: "left" }}>Requested</th>
                    <th style={{ textAlign: "left" }}>Fulfilled</th>
                    <th style={{ textAlign: "left" }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {actionData.previewRows.map((row, idx) => {
                    const isNotFound =
                      row.status === "sku not found" ||
                      row.status === "error";
                    const isNoStock = row.status === "no stock";

                    let textColor = "#000000";
                    if (isNotFound) {
                      textColor = "#ff0000"; // red
                    } else if (isNoStock) {
                      textColor = "#fcb001";
                    }

                    const isOddRow = idx % 2 === 0; // 0-based index: 0,2,4... are 1st,3rd,5th rows
                    const backgroundColor = isOddRow ? "#ffffff" : "#f7f7f7";

                    return (
                      <tr
                        key={idx}
                        style={{
                          backgroundColor,
                          color: textColor,
                        }}
                      >
                        <td style={{ textAlign: "left" }}>{row.sku}</td>
                        <td style={{ textAlign: "left" }}>
                          {row.productName || "* * * * * * *"}
                        </td>
                        <td style={{ textAlign: "left" }}>
                          {row.availableQuantity}
                        </td>
                        <td style={{ textAlign: "left" }}>
                          {row.quantityRequested}
                        </td>
                        <td style={{ textAlign: "left" }}>
                          {row.fulfilledQuantity}
                        </td>
                        <td style={{ textAlign: "left" }}>{row.status}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </s-box>

            {/* Confirmation form: create order + save history */}
            <div style={{ marginTop: "20px" }}>
              <s-box style={{ marginTop: "20px", textAlign: "center" }}>
                <s-stack
                  direction="inline"
                  gap="base"
                  style={{ justifyContent: "center" }}
                >
                  {/* Confirm create order form */}
                  <Form method="post">
                    <input type="hidden" name="intent" value="create" />
                    <input
                      type="hidden"
                      name="customerName"
                      value={actionData.customerName || ""}
                    />
                    <input
                      type="hidden"
                      name="customerId"
                      value={actionData.customerId || ""}
                    />
                    <input
                      type="hidden"
                      name="previewJson"
                      value={JSON.stringify(
                        actionData.previewRows || [],
                      )}
                    />

                    <s-button
                      type="submit"
                      variant="primary"
                      {...(isSubmitting ? { loading: true } : {})}
                    >
                      <span
                        style={{
                          display: "inline-block",
                          padding: "3px 5px",
                          fontSize: "14px",
                        }}
                      >
                        Confirm create order
                      </span>
                    </s-button>
                  </Form>

                  {/* Cancel button: just hide preview + clear inputs */}
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
                    <span
                      style={{
                        display: "inline-block",
                        padding: "3px 5px",
                        fontSize: "14px",
                      }}
                    >
                      Cancel
                    </span>
                  </s-button>
                </s-stack>
              </s-box>
            </div>
          </s-section>
        )}

        {/* History section – hidden while preview is visible */}
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

            {/* Success banner (after redirect with createdOrderName) */}
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
                The draft order {createdOrderName} has been successfully
                created.
              </div>
            )}

            {history.length === 0 ? (
              <s-paragraph>No bulk imports yet.</s-paragraph>
            ) : (
              <s-box
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
              >
                <table
                  width="100%"
                  cellPadding={6}
                  style={{ borderCollapse: "collapse" }}
                >
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left" }}>Customer</th>
                      <th style={{ textAlign: "left" }}>Order (Draft)</th>
                      <th style={{ textAlign: "left" }}>Total Qty</th>
                      <th style={{ textAlign: "left" }}>Created At</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((item, idx) => {
                      const isOddRow = idx % 2 === 0;
                      const backgroundColor = isOddRow
                        ? "#ffffff"
                        : "#f7f7f7";

                      return (
                        <tr key={item.id} style={{ backgroundColor }}>
                          <td style={{ textAlign: "left" }}>
                            {shopAdminSubdomain && item.customerId ? (
                              <a
                                href={`https://admin.shopify.com/store/${shopAdminSubdomain}/customers/${item.customerId}`}
                                target="_blank"
                                rel="noreferrer"
                                style={{
                                  color: "#005bd3",
                                  textDecoration: "underline",
                                }}
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
                                style={{
                                  color: "#005bd3",
                                  textDecoration: "underline",
                                }}
                              >
                                {item.orderName ||
                                  item.orderLegacyId ||
                                  item.orderId}
                              </a>
                            ) : (
                              item.orderName ||
                              item.orderLegacyId ||
                              item.orderId
                            )}
                          </td>
                          <td style={{ textAlign: "left" }}>
                            {item.totalQuantity}
                          </td>
                          <td style={{ textAlign: "left" }}>
                            {new Date(item.createdAt).toLocaleString(
                              "en-AU",
                              {
                                dateStyle: "medium",
                                timeStyle: "short",
                              },
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </s-box>
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
