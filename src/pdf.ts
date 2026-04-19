import puppeteer from "@cloudflare/puppeteer"
import type { CompanyInfo, CustomerData, ChargeData, SubscriptionInfo } from "./stripe"

export async function createInvoicePDF(
  c: any,
  companyInfo: CompanyInfo,
  customerData: CustomerData,
  invoiceNumber: string,
  chargeData: ChargeData,
  subscriptionInfo: SubscriptionInfo | null = null,
): Promise<Buffer> {
  const browser = await puppeteer.launch(c.env.MYBROWSER)
  console.log(`Generating invoice PDF using Puppeteer`)

  const htmlContent = generateInvoiceHTML(
    companyInfo,
    customerData,
    invoiceNumber,
    chargeData,
    subscriptionInfo,
  )

  const page = await browser.newPage()
  await page.setContent(htmlContent, { waitUntil: "domcontentloaded" })
  const pdfBuffer = await page.pdf({
    format: "Letter",
    printBackground: true,
    margin: { top: "40px", right: "40px", bottom: "40px", left: "40px" },
  })
  await page.close()

  console.log(`PDF invoice generated successfully with Puppeteer`)
  return pdfBuffer
}

function esc(s: string | null | undefined): string {
  if (s == null) return ""
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function formatUsDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
}

function renderCompanyAddress(companyInfo: CompanyInfo): string {
  const parts = companyInfo.addressParts
  if (!parts) {
    if (!companyInfo.address || companyInfo.address === "Not Set") return ""
    return `<div>${esc(companyInfo.address)}</div>`
  }
  const lines: string[] = []
  if (parts.line1) lines.push(parts.line1)
  if (parts.line2) lines.push(parts.line2)
  const cityStateZip = [parts.city, parts.state, parts.postal_code].filter(Boolean).join(" ")
  if (cityStateZip) lines.push(cityStateZip)
  if (parts.country && parts.country.toUpperCase() !== "US" && parts.country.toUpperCase() !== "UNITED STATES") {
    lines.push(parts.country)
  }
  return lines.map((l) => `<div>${esc(l)}</div>`).join("")
}

function renderCustomerAddress(customerData: CustomerData): string {
  const a = customerData.address
  if (!a) return ""
  const lines: string[] = []
  if (a.line1) lines.push(a.line1)
  if (a.line2) lines.push(a.line2)
  const cityStateZip = [a.city, a.state, a.postal_code].filter(Boolean).join(" ")
  if (cityStateZip) lines.push(cityStateZip)
  if (a.country && a.country.toUpperCase() !== "US") lines.push(a.country)
  return lines.map((l) => `<div>${esc(l)}</div>`).join("")
}

function generateInvoiceHTML(
  companyInfo: CompanyInfo,
  customerData: CustomerData,
  invoiceNumber: string,
  chargeData: ChargeData,
  subscriptionInfo: SubscriptionInfo | null,
): string {
  const currency = chargeData.currency?.toUpperCase() || "USD"
  const amount = (chargeData.amount / 100).toFixed(2)
  const formattedAmount = `$${amount}`
  const formattedAmountWithCurrency = currency === "USD" ? formattedAmount : `${formattedAmount} ${currency}`

  const dateCreated = new Date(chargeData.created * 1000)
  const dateIssued = formatUsDate(dateCreated)

  let paymentMethod = "Card"
  if (chargeData.payment_method_details?.type === "card") {
    const card = chargeData.payment_method_details.card
    if (card?.brand && card?.last4) {
      const brand = card.brand.charAt(0).toUpperCase() + card.brand.slice(1)
      paymentMethod = `${brand} ending in ${card.last4}`
    }
  } else if (chargeData.payment_method_details?.type) {
    const t = chargeData.payment_method_details.type
    paymentMethod = t.charAt(0).toUpperCase() + t.slice(1).replace(/_/g, " ")
  }

  let description = chargeData.description || `Charge ${chargeData.id}`
  let subscriptionPeriod = ""
  if (subscriptionInfo) {
    description = subscriptionInfo.planName || description
    if (subscriptionInfo.current_period_start && subscriptionInfo.current_period_end) {
      const startDate = new Date(subscriptionInfo.current_period_start * 1000)
      const endDate = new Date(subscriptionInfo.current_period_end * 1000)
      subscriptionPeriod = `${formatUsDate(startDate)} to ${formatUsDate(endDate)}`
    }
  }

  const brand = companyInfo.brandColor || "#4f46e5"
  const brandMuted = companyInfo.secondaryColor || "#e5e7eb"
  const hasCompanyEmail = companyInfo.email && companyInfo.email !== "Not Set"
  const hasCompanyVat = companyInfo.vatId && companyInfo.vatId !== "Not Set"
  const hasCustomerVat = customerData.vatId && customerData.vatId !== "Unknown" && customerData.vatId !== "Not Set"

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Invoice ${esc(invoiceNumber)}</title>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          color: #111827;
          line-height: 1.45;
          font-size: 13px;
          padding: 32px;
        }
        .container { width: 100%; max-width: 720px; margin: 0 auto; }
        .accent-bar {
          height: 4px;
          background: ${brand};
          border-radius: 2px;
          margin-bottom: 28px;
        }
        .header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 24px;
          margin-bottom: 32px;
        }
        .header h1 {
          font-size: 28px;
          font-weight: 700;
          color: #111827;
          letter-spacing: -0.02em;
        }
        .header .company-brand {
          text-align: right;
        }
        .company-brand .logo { max-height: 44px; max-width: 180px; margin-bottom: 8px; }
        .company-brand .name { font-size: 15px; font-weight: 600; color: #111827; }
        .meta-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 32px;
          margin-bottom: 28px;
        }
        .meta-block .label {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: ${brand};
          font-weight: 600;
          margin-bottom: 6px;
        }
        .meta-block .value { color: #111827; }
        .meta-block .value .key { color: #6b7280; display: inline-block; min-width: 90px; }
        .address-block div { color: #374151; }
        .address-block .name-line { font-weight: 600; color: #111827; margin-bottom: 2px; }
        .amount-hero {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          padding: 16px 20px;
          border-left: 3px solid ${brand};
          background: #f9fafb;
          border-radius: 0 6px 6px 0;
          margin-bottom: 28px;
        }
        .amount-hero .amount {
          font-size: 24px;
          font-weight: 600;
          color: #111827;
        }
        .amount-hero .status {
          font-size: 13px;
          font-weight: 500;
          color: #059669;
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 20px;
        }
        thead th {
          text-align: left;
          padding: 8px 0;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: #6b7280;
          font-weight: 600;
          border-bottom: 1px solid #e5e7eb;
        }
        thead th:last-child { text-align: right; }
        tbody td {
          padding: 14px 0;
          vertical-align: top;
          border-bottom: 1px solid #f3f4f6;
        }
        tbody td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
        .line-meta {
          color: #6b7280;
          font-size: 12px;
          margin-top: 2px;
        }
        .totals {
          margin-top: 8px;
          margin-left: auto;
          width: 260px;
        }
        .totals-row {
          display: flex;
          justify-content: space-between;
          padding: 6px 0;
          font-variant-numeric: tabular-nums;
        }
        .totals-row.total {
          border-top: 1px solid #e5e7eb;
          padding-top: 10px;
          margin-top: 4px;
          font-weight: 600;
          color: #111827;
        }
        .totals-row.paid {
          color: #059669;
          font-weight: 600;
        }
        .totals-row .label { color: #6b7280; }
        .footer {
          margin-top: 48px;
          padding-top: 16px;
          border-top: 1px solid #e5e7eb;
          display: flex;
          justify-content: space-between;
          font-size: 11px;
          color: #6b7280;
        }
        .footer a { color: ${brand}; text-decoration: none; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="accent-bar"></div>

        <div class="header">
          <div>
            <h1>Invoice</h1>
          </div>
          <div class="company-brand">
            ${companyInfo.logo ? `<img src="${esc(companyInfo.logo)}" alt="${esc(companyInfo.name)}" class="logo">` : ""}
            <div class="name">${esc(companyInfo.name)}</div>
          </div>
        </div>

        <div class="meta-grid">
          <div class="meta-block">
            <div class="label">Invoice</div>
            <div class="value">
              <div><span class="key">Number</span>${esc(invoiceNumber)}</div>
              <div><span class="key">Date</span>${esc(dateIssued)}</div>
              <div><span class="key">Payment</span>${esc(paymentMethod)}</div>
            </div>
          </div>
          <div class="meta-block">
            <div class="label">From</div>
            <div class="value address-block">
              <div class="name-line">${esc(companyInfo.name)}</div>
              ${renderCompanyAddress(companyInfo)}
              ${hasCompanyEmail ? `<div>${esc(companyInfo.email)}</div>` : ""}
              ${hasCompanyVat ? `<div>VAT ${esc(companyInfo.vatId)}</div>` : ""}
            </div>
          </div>
        </div>

        <div class="meta-grid">
          <div class="meta-block">
            <div class="label">Billed to</div>
            <div class="value address-block">
              <div class="name-line">${esc(customerData.name || "Customer")}</div>
              ${renderCustomerAddress(customerData)}
              ${customerData.email ? `<div>${esc(customerData.email)}</div>` : ""}
              ${hasCustomerVat ? `<div>VAT ${esc(customerData.vatId)}</div>` : ""}
            </div>
          </div>
          <div class="meta-block"></div>
        </div>

        <div class="amount-hero">
          <div class="amount">${esc(formattedAmountWithCurrency)}</div>
          <div class="status">Paid ${esc(formatUsDate(dateCreated))}</div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Description</th>
              <th style="width: 48px;">Qty</th>
              <th style="width: 96px;">Unit price</th>
              <th style="width: 96px;">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                ${esc(description)}
                ${subscriptionPeriod ? `<div class="line-meta">${esc(subscriptionPeriod)}</div>` : ""}
              </td>
              <td>1</td>
              <td>${esc(formattedAmount)}</td>
              <td>${esc(formattedAmount)}</td>
            </tr>
          </tbody>
        </table>

        <div class="totals">
          <div class="totals-row">
            <span class="label">Subtotal</span>
            <span>${esc(formattedAmount)}</span>
          </div>
          <div class="totals-row total">
            <span>Total</span>
            <span>${esc(formattedAmount)}</span>
          </div>
          <div class="totals-row paid">
            <span>Amount paid</span>
            <span>${esc(formattedAmountWithCurrency)}</span>
          </div>
        </div>

        <div class="footer">
          <div>${esc(invoiceNumber)}</div>
          ${hasCompanyEmail ? `<div>Questions? <a href="mailto:${esc(companyInfo.email)}">${esc(companyInfo.email)}</a></div>` : "<div></div>"}
        </div>
      </div>
    </body>
    </html>
  `
}
