// ============================================================
// HOTILAL JEWELLERS — DYNAMIC PRICING ENGINE
// ============================================================
// This server connects to Shopify and updates product prices
// based on live metal rates entered in the admin panel.
//
// PRICING FORMULA:
//   Gold/Diamond Products:
//     Final Price = (Metal Value + Making Charge + HUID + Cert Charge) + GST(3%)
//
//   Silver Jewellery:
//     Final Price = Silver Value + HUID + GST(3%)  [no making charge]
//
//   Silver Bars & Coins (title contains "bar" or "coin"):
//     Final Price = Silver Value (bullion rate) + HUID + GST(3%)  [no making charge]
//
// HUID NOTE:
//   huid_charge = huid_rate × no_of_items
//   If no_of_items = 0 → huid_charge = 0 (row hidden on website too)
// ============================================================

import dotenv from "dotenv";
import express from "express";
import axios from "axios";
import cors from "cors";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const SHOPIFY_URL = `https://${process.env.SHOPIFY_STORE}/admin/api/2026-07/graphql.json`;

let cachedShopifyToken = null;
let shopifyTokenExpiresAt = 0;

async function getShopifyAccessToken() {
  if (
    cachedShopifyToken &&
    Date.now() < shopifyTokenExpiresAt
  ) {
    return cachedShopifyToken;
  }

  const shop = process.env.SHOPIFY_STORE;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!shop || !clientId || !clientSecret) {
    throw new Error(
      "Missing Shopify environment variables. Check Render settings."
    );
  }

  const response = await axios.post(
    `https://${shop}/admin/oauth/access_token`,
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  if (!response.data.access_token) {
    throw new Error("Shopify access token was not returned.");
  }

  cachedShopifyToken = response.data.access_token;

  const expiresIn = Number(response.data.expires_in || 86399);
  shopifyTokenExpiresAt =
    Date.now() + Math.max(60, expiresIn - 300) * 1000;

  return cachedShopifyToken;
}

// ============================================================
// PROGRESS TRACKER — used by frontend polling
// ============================================================
let updateProgress = {
  running: false,
  total: 0,
  done: 0,
  status: "idle",
  message: "",
};

// ============================================================
// ROUTE: POST /update-prices
// Receives rates from the admin panel form and starts
// the background price update job immediately.
// Returns instantly so the UI doesn't freeze.
// ============================================================
app.post("/update-prices", async (req, res) => {
  // --- Gold Rates (per gram) ---
  const goldRate22K = Number(req.body.goldRate22K || 0);
  const goldRate18K = Number(req.body.goldRate18K || 0);
  const goldRate14K = Number(req.body.goldRate14K || 0);

  // --- Silver Rates (per gram) ---
  const silverRate = Number(req.body.silverRate || 0); // for jewellery
  const silverBullionRate = Number(req.body.silverBullionRate || 0); // for bars & coins

  // --- Diamond Rates (per carat) ---
  const igiDiamondRate = Number(req.body.igiDiamondRate || 0); // IJSI grade
  const giaDiamondRate = Number(req.body.giaDiamondRate || 0); // HIVS-SI grade
  const hrdDiamondRate = Number(req.body.hrdDiamondRate || 0); // GHVVS-VS grade

  // --- Other Charges ---
  const huid = Number(req.body.huid || 0); // flat per piece
  const diamondCertCharge = Number(req.body.diamondCertCharge || 0); // flat per diamond product

  console.log("📥 Rates received:", {
    goldRate22K,
    goldRate18K,
    goldRate14K,
    silverRate,
    silverBullionRate,
    igiDiamondRate,
    giaDiamondRate,
    hrdDiamondRate,
    huid,
    diamondCertCharge,
  });

  // ✅ Respond immediately — background job handles the rest
  res.json({ message: "Price update started! Tracking progress below." });

  // 🔄 Start background update
  runPriceUpdate(
    goldRate22K,
    goldRate18K,
    goldRate14K,
    silverRate,
    silverBullionRate,
    igiDiamondRate,
    giaDiamondRate,
    hrdDiamondRate,
    huid,
    diamondCertCharge,
  );
});

// ============================================================
// ROUTE: GET /update-progress
// Frontend polls this every 1 second to show the progress bar
// ============================================================
app.get("/update-progress", (req, res) => {
  res.json(updateProgress);
});

// ============================================================
// BACKGROUND JOB: runPriceUpdate
// Fetches all products and updates prices in batches of 5
// ============================================================
async function runPriceUpdate(
  goldRate22K,
  goldRate18K,
  goldRate14K,
  silverRate,
  silverBullionRate,
  igiDiamondRate,
  giaDiamondRate,
  hrdDiamondRate,
  huid,
  diamondCertCharge,
) {
  updateProgress = {
    running: true,
    total: 0,
    done: 0,
    status: "running",
    message: "Fetching products...",
  };

  try {
    // Fetch all products using pagination (handles 1000+ products)
    const products = await fetchAllProducts();
    updateProgress.total = products.length;
    updateProgress.message = `Updating ${products.length} products...`;

    // Process in batches of 5 to respect Shopify rate limits
    await processBatch(products, 5, async (productEdge) => {
      const product = productEdge.node;

      // ----------------------------------------------------------
      // STEP 1: Read metafields for this product
      // ----------------------------------------------------------
      const metafieldsMap = {};
      product.metafields.edges.forEach((edge) => {
        const m = edge.node;
        metafieldsMap[m.key] = m.value; // keep as string (we parse below)
      });

      const goldWeight = Number(metafieldsMap.gold_weight || 0);
      const silverWeight = Number(metafieldsMap.silver_weight || 0);
      const diamondCarat = Number(metafieldsMap.diamond_carat || 0);

      // no_of_items drives HUID calculation
      // If 0 → HUID becomes 0 and row is hidden on website
      const noOfItems = Number(metafieldsMap.no_of_items || 0);

      const productTitle = product.title.toLowerCase();

      // ----------------------------------------------------------
      // STEP 2: Detect product type
      // ----------------------------------------------------------

      // Silver bar or coin: has silver weight, no gold, and title has "bar" or "coin"
      const isSilverBullion =
        silverWeight > 0 &&
        goldWeight === 0 &&
        (productTitle.includes("bar") || productTitle.includes("coin"));

      // Pure silver jewellery: has silver weight, no gold, not a bullion product
      const isSilverOnly =
        silverWeight > 0 && goldWeight === 0 && !isSilverBullion;

      // ----------------------------------------------------------
      // STEP 3: Pick correct silver rate
      // ----------------------------------------------------------
      const activeSilverRate = isSilverBullion ? silverBullionRate : silverRate;

      // ----------------------------------------------------------
      // STEP 4: Pick correct gold rate + making charge % by karat
      // ----------------------------------------------------------
      const metalType = (metafieldsMap.metal_type || "22K")
        .toString()
        .trim()
        .toUpperCase();

      let goldRate = goldRate22K;
      let makingChargePercent = 0.15; // 22K default

      if (metalType.includes("18")) {
        goldRate = goldRate18K;
        makingChargePercent = 0.18;
      } else if (metalType.includes("14")) {
        goldRate = goldRate14K;
        makingChargePercent = 0.2;
      }

      // ----------------------------------------------------------
      // STEP 5: Pick correct diamond rate by certification type
      // ----------------------------------------------------------
      const diamondType = (metafieldsMap.diamond_type || "")
        .toString()
        .trim()
        .toUpperCase();

      let diamondRate = igiDiamondRate; // default: IGI / IJSI

      if (diamondType.includes("GIA") || diamondType.includes("HIVS")) {
        diamondRate = giaDiamondRate;
      } else if (diamondType.includes("HRD") || diamondType.includes("GHVVS")) {
        diamondRate = hrdDiamondRate;
      }

      // ----------------------------------------------------------
      // STEP 6: Calculate metal values
      // ----------------------------------------------------------
      const goldValue = goldWeight * goldRate;
      const silverValue = silverWeight * activeSilverRate;
      const diamondValue = diamondCarat * diamondRate;

      const metalSubtotal = goldValue + silverValue + diamondValue;

      // ----------------------------------------------------------
      // STEP 7: Making charge
      //   - Gold products: makingChargePercent of metalSubtotal
      //   - Silver jewellery: NO making charge
      //   - Silver bars/coins: NO making charge
      // ----------------------------------------------------------
      const makingCharge =
        isSilverOnly || isSilverBullion
          ? 0
          : metalSubtotal * makingChargePercent;

      // Save 0 for silver so the UI row is hidden automatically
      const makingChargePercentSaved =
        isSilverOnly || isSilverBullion ? 0 : makingChargePercent * 100;

      // ----------------------------------------------------------
      // STEP 8: HUID charge
      //   huid_charge = huid_rate × no_of_items
      //   If no_of_items = 0 → huid_charge = 0
      //   (Website hides the HUID row when this value = 0)
      // ----------------------------------------------------------
      const huidCharge = huid * noOfItems; // 0 × anything = 0 when noOfItems = 0

      // ----------------------------------------------------------
      // STEP 9: Diamond certificate charge
      //   Added only when the product has a diamond
      // ----------------------------------------------------------
      const certCharge =
        diamondCarat > 0 && diamondRate > 0 ? diamondCertCharge : 0;

      // Total HUID + cert (saved together as one line in breakdown)
      const totalHuidAndCert = huidCharge + certCharge;

      // ----------------------------------------------------------
      // STEP 10: Final price calculation
      //   Subtotal = metals + making + huid + cert
      //   GST (3%) applied on subtotal excluding HUID/cert charges
      //   Final Price = subtotal + GST
      // ----------------------------------------------------------
      const subtotal = metalSubtotal + makingCharge + totalHuidAndCert;
      const gstBase = metalSubtotal + makingCharge; // GST not on HUID/cert
      const gst = gstBase * 0.03;
      const finalPrice = (subtotal + gst).toFixed(2);

      // ----------------------------------------------------------
      // STEP 11: Update Shopify variant price
      // ----------------------------------------------------------
      const variants = product.variants.edges.map((v) => ({
        id: v.node.id,
        price: finalPrice,
      }));

      await updateVariantPrice(product.id, variants);

      // ----------------------------------------------------------
      // STEP 12: Save full breakdown into product metafields
      //   These are read by price-breakdown.liquid on the website
      // ----------------------------------------------------------
      await saveBreakdownMetafields(product.id, {
        gold_value: goldValue.toFixed(2),
        silver_value: silverValue.toFixed(2),
        diamond_value: diamondValue.toFixed(2),
        making_charge: makingCharge.toFixed(2),
        making_charge_percent: makingChargePercentSaved.toFixed(0),
        huid: totalHuidAndCert.toFixed(2), // combined HUID + cert
        subtotal: subtotal.toFixed(2),
        gst: gst.toFixed(2),
        final_price: finalPrice,
        gold_rate: goldRate.toFixed(2),
        silver_rate: activeSilverRate.toFixed(2), // saves actual rate used
        diamond_rate: diamondRate.toFixed(2),
      });

      // Update progress tracker
      updateProgress.done++;
      console.log(
        `✅ ${updateProgress.done}/${updateProgress.total} — ${product.title}` +
          ` [${metalType}]` +
          ` [${isSilverBullion ? "BULLION" : isSilverOnly ? "SILVER" : "GOLD"}]` +
          ` [${diamondType || "No Diamond"}]` +
          ` → ₹${finalPrice}`,
      );
    });

    updateProgress = {
      running: false,
      total: updateProgress.total,
      done: updateProgress.total,
      status: "done",
      message: `✅ All ${updateProgress.total} products updated!`,
    };
  } catch (err) {
    updateProgress = {
      running: false,
      total: 0,
      done: 0,
      status: "error",
      message: "❌ Update failed: " + err.message,
    };

    console.error("❌ Error:", err.message);
    console.error("Status:", err.response?.status);
    console.error("Shopify response:", err.response?.data);
  }
}

// ============================================================
// HELPER: fetchAllProducts
// Fetches all products using Shopify pagination (cursor-based)
// Handles stores with 1000+ products without missing any
// ============================================================
async function fetchAllProducts() {
  let allProducts = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const query = `
    {
      products(first: 50${cursor ? `, after: "${cursor}"` : ""}) {
        edges {
          cursor
          node {
            id
            title
            metafields(first: 50, namespace: "custom") {
              edges {
                node {
                  key
                  value
                }
              }
            }
            variants(first: 50) {
              edges {
                node {
                  id
                  price
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }
    `;

    const response = await axios.post(
      SHOPIFY_URL,
      { query },
      {
        headers: {
          "X-Shopify-Access-Token": await getShopifyAccessToken(),
          "Content-Type": "application/json",
        },
      },
    );

    const data = response.data.data.products;
    const edges = data.edges;

    allProducts = [...allProducts, ...edges];
    hasNextPage = data.pageInfo.hasNextPage;

    if (hasNextPage && edges.length > 0) {
      cursor = edges[edges.length - 1].cursor;
    }

    console.log(`📦 Fetched ${allProducts.length} products so far...`);

    // Small delay between pages to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  console.log(`📦 Total products fetched: ${allProducts.length}`);
  return allProducts;
}

// ============================================================
// HELPER: updateVariantPrice
// Updates all variants of a product with the new final price
// ============================================================
async function updateVariantPrice(productId, variants) {
  const mutation = `
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          price
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = { productId, variants };

  const response = await axios.post(
    SHOPIFY_URL,
    { query: mutation, variables },
    {
      headers: {
        "X-Shopify-Access-Token": await getShopifyAccessToken(),
        "Content-Type": "application/json",
      },
    },
  );

  if (response.data.data.productVariantsBulkUpdate.userErrors.length) {
    console.error(
      "⚠️ Variant update errors:",
      response.data.data.productVariantsBulkUpdate.userErrors,
    );
  }
}

// ============================================================
// HELPER: saveBreakdownMetafields
// Saves the full price breakdown into product metafields
// These are read by price-breakdown.liquid on the product page
// ============================================================
async function saveBreakdownMetafields(productId, breakdown) {
  const mutation = `
    mutation UpdateProductMetafields($input: ProductInput!) {
      productUpdate(input: $input) {
        product {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const metafields = Object.entries(breakdown).map(([key, value]) => ({
    namespace: "custom",
    key: key,
    value: String(value),
    type: key === "diamond_type" ? "single_line_text_field" : "number_decimal",
  }));

  const variables = {
    input: { id: productId, metafields },
  };

  const response = await axios.post(
    SHOPIFY_URL,
    { query: mutation, variables },
    {
      headers: {
        "X-Shopify-Access-Token": wait getShopifyAccessToken(),
        "Content-Type": "application/json",
      },
    },
  );

  if (response.data.data.productUpdate.userErrors.length) {
    console.error(
      "⚠️ Metafield save errors:",
      response.data.data.productUpdate.userErrors,
    );
  }
}

// ============================================================
// HELPER: processBatch
// Processes products in parallel batches of `batchSize`
// with a 500ms delay between batches to respect Shopify
// API rate limits (prevents 429 Too Many Requests errors)
// ============================================================
async function processBatch(items, batchSize, handler) {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map(handler));

    console.log(
      `✅ Batch ${Math.floor(i / batchSize) + 1}` +
        `/${Math.ceil(items.length / batchSize)} done`,
    );

    // Wait between batches (not after the last one)
    if (i + batchSize < items.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
