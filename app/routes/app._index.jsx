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
    const customerNameRaw = formData.get("customerName") || "";
    const customerIdRaw = formData.get("customerId") || "";
    const customerName = customerNameRaw.trim();
    const customerId = customerIdRaw.trim();
    const file = formData.get("file");

    const missingCustomer = !customerName || !customerId;
    const missingFile = !file || typeof file === "string";

    if (missingCustomer || missingFile) {
      let errorMessage =
        "Customer selection and CSV/Excel file are required to import orders.";
      console.warn("PROCESS validation failed:", {
        missingCustomer,
        missingFile,
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

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

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

    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
    });

    if (!rows || rows.length === 0) {
      console.warn("PROCESS: uploaded file appears empty");
      return {
        mode: "error",
        error: "The file is empty.",
        customerName,
        customerId,
        previewRows: [],
      };
    }

    const headerRow = rows[0].map((h) => String(h).trim().toLowerCase());
    const skuIndex = headerRow.findIndex((h) => h === "sku");
    const qtyIndex = headerRow.findIndex((h) => h === "quantity" || h === "qty");

    if (skuIndex === -1 || qtyIndex === -1) {
      console.warn("PROCESS: missing sku/quantity columns in headerRow", headerRow);
      return {
        mode: "error",
        error: "Header row must contain 'sku' and 'quantity' (or 'qty') columns.",
        customerName,
        customerId,
        previewRows: [],
      };
    }

    const dataRows = rows.slice(1);
    const parsedRows = [];

    for (const row of dataRows) {
      const rawSku = row[skuIndex];
      const rawQty = row[qtyIndex];

      const sku = String(rawSku || "").trim();
      if (!sku) continue;

      const quantityRequested = Number(rawQty || 0);
      if (!Number.isFinite(quantityRequested) || quantityRequested <= 0) continue;

      parsedRows.push({
        sku,
        productName: "",
        exist: false,
        availableQuantity: 0,
        quantityRequested,
        fulfilledQuantity: 0,
        status: "pending",
        variantId: null,
      });
    }

    if (parsedRows.length === 0) {
      console.warn("PROCESS: no valid rows found after parsing");
      return {
        mode: "error",
        error:
          "No valid rows found. Please check that SKU and Quantity columns are filled.",
        customerName,
        customerId,
        previewRows: [],
      };
    }

    console.log("PROCESS: parsedRows count:", parsedRows.length);

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
              query: `sku:"${sku}"`,
            },
          },
        );

        const json = await response.json();
        if (json?.errors?.length) {
          console.error("GraphQL errors for SKU", sku, json.errors);
        }

        const edges = json?.data?.productVariants?.edges || [];
        const variantNode = edges.length > 0 ? edges[0].node : null;

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

        enrichedRows.push({
          ...row,
          exist: true,
          productName,
          availableQuantity: totalAvailable,
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

    console.log("PROCESS: enrichedRows count:", enrichedRows.length);

    return {
      mode: "preview",
      customerName,
      customerId,
      previewRows: enrichedRows,
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
    }
  }, [hasSuccess]);

  useEffect(() => {
    setPreviewCancelled(false);
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
  };

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

          <div
            style={{
              display: "flex",
              gap: "24px",
              alignItems: "stretch",
              paddingBottom: "10px",
            }}
          >
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
                  <label style={{ display: "block", marginBottom: "0.25rem" }}>
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
                  {isSubmitting ? "Uploading..." : "Preview order"}
                </button>
              </Form>
            </div>

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
              <div style={{ fontWeight: 600, marginBottom: "8px", fontSize: "14px" }}>
                Excel Format
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
              Review the items before creating the order. Only existing SKUs with available
              inventory will be added.
            </s-paragraph>

            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <table width="100%" cellPadding={6} style={{ borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>SKU</th>
                    <th style={{ textAlign: "left" }}>Product Name</th>
                    <th style={{ textAlign: "left" }}>Available</th>
                    <th style={{ textAlign: "left" }}>Requested</th>
                    <th style={{ textAlign: "left" }}>Fulfilled</th>
                    <th style={{ textAlign: "left", width: "100px" }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {actionData.previewRows.map((row, idx) => {
                    const isNotFound = row.status === "sku not found" || row.status === "error";
                    const isNoStock = row.status === "no stock";

                    let textColor = "#000000";
                    if (isNotFound) textColor = "#ff0000";
                    else if (isNoStock) textColor = "#aaaaaa";

                    const isOddRow = idx % 2 === 0;
                    const backgroundColor = isOddRow ? "#ffffff" : "#f7f7f7";

                    return (
                      <tr key={idx} style={{ backgroundColor, color: textColor }}>
                        <td style={{ textAlign: "left" }}>{row.sku}</td>
                        <td style={{ textAlign: "left" }}>
                          {row.productName || "* * * * * * *"}
                        </td>
                        <td style={{ textAlign: "left" }}>{row.availableQuantity}</td>
                        <td style={{ textAlign: "left" }}>{row.quantityRequested}</td>
                        <td style={{ textAlign: "left" }}>{row.fulfilledQuantity}</td>
                        <td style={{ textAlign: "left" }}>{row.status}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </s-box>

            <div style={{ marginTop: "20px" }}>
              <s-box style={{ marginTop: "20px", textAlign: "center" }}>
                <s-stack direction="inline" gap="base" style={{ justifyContent: "center" }}>
                  <Form method="post">
                    <input type="hidden" name="intent" value="create" />
                    <input type="hidden" name="customerName" value={actionData.customerName || ""} />
                    <input type="hidden" name="customerId" value={actionData.customerId || ""} />
                    <input type="hidden" name="previewJson" value={JSON.stringify(actionData.previewRows || [])} />

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
