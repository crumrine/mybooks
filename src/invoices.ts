import { sendEmail } from "./email"
import { getCompanyInfo, getSubscriptionInfo, getCustomerData, getChargeData, getFormattedVatNumber } from "./stripe"
import { createInvoicePDF } from "./pdf"
import { nextInvoiceNumber } from "./invoiceNumber"

// Helper function to send invoice
export async function sendInvoice(c: any, customerId: string, chargeId: string) {
  // Fetch customer data from Stripe
  console.log("Fetching customer data from Stripe")
  const customerData = await getCustomerData(c, customerId)
  const email = customerData.email || ""
  const name = customerData.name || "Customer"

  // Fetch specific charge for the customer
  console.log("Fetching charge data from Stripe")
  const chargeData = await getChargeData(c, chargeId)
  const chargeDate = chargeData.created
    ? formatDateInWords(new Date(chargeData.created * 1000))
    : "N/A"

  // Fetch subscription information if available
  const subscriptionInfo = await getSubscriptionInfo(c, customerId, chargeId)

  // Fetch company info for branding and legal information
  const companyInfo = await getCompanyInfo(c)

  // Get the needed data from companyInfo
  const logoUrl = companyInfo.logo
  const brandColor = companyInfo.brandColor
  const secondaryColor = companyInfo.secondaryColor
  const companyName = companyInfo.name
  const companyAddress = companyInfo.address
  const companyEmail = companyInfo.email
  const formattedVat = companyInfo.vatId

  // Get the actual VAT number from the tax ID object
  const formattedVatNumber = await getFormattedVatNumber(c, formattedVat)

  console.log("logoUrl", logoUrl)
  console.log("brandColor", brandColor)
  console.log("secondaryColor", secondaryColor)
  console.log("companyName", companyName)
  console.log("companyAddress", companyAddress)
  console.log("companyEmail", companyEmail)
  console.log("companyVat", formattedVatNumber)

  const invoiceNumber = await nextInvoiceNumber(c.env)

  const isDevMode = c.env.DEV_MODE === "true"
  const recipientEmail = isDevMode && c.env.DEV_EMAIL ? c.env.DEV_EMAIL : email


  // Format the amount for display
  const formattedAmount = chargeData.price_string || `$${(chargeData.amount / 100).toFixed(2)}`

  // Get payment method details
  let paymentMethodDisplay = "Card"
  let lastFour = ""

  if (chargeData.payment_method_details && chargeData.payment_method_details.type === "card") {
    const card = chargeData.payment_method_details.card
    if (card && card.brand && card.last4) {
      paymentMethodDisplay = card.brand.toUpperCase()
      lastFour = card.last4
    }
  }

  // Get billing period if subscription exists
  let billingPeriod = ""
  if (subscriptionInfo && subscriptionInfo.current_period_start && subscriptionInfo.current_period_end) {
    const startDate = new Date(subscriptionInfo.current_period_start * 1000)
    const endDate = new Date(subscriptionInfo.current_period_end * 1000)

    const formatDate = (date: Date): string => {
      return formatDateInWords(date).toUpperCase()
    }

    billingPeriod = `${formatDate(startDate)} to ${formatDate(endDate)}`
  }

  // Construct email content with Stripe-like styling
  const billingUrl = `https://${c.env.APP_DOMAIN}/billing/${customerId}`
  const stripeCustomerPortalUrl = `https://billing.stripe.com/p/login/customer/${customerId}`

  const emailContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Invoice from ${companyName}</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            color: #1a1a1a;
            background-color: #f9f9f9;
            margin: 0;
            padding: 0;
            -webkit-text-size-adjust: none;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
          }
          .wrapper {
            width: 100%;
            max-width: 600px;
            margin: 0 auto;
            padding: 40px 20px;
          }
          .container {
            background-color: #ffffff;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
            margin-bottom: 20px;
          }
          .header {
            padding: 20px;
          }
          .logo {
            border-radius: 100%;
            max-height: 40px;
            max-width: 180px;
          }
          .company-name {
            font-size: 20px;
            font-weight: 600;
            margin: 0;
          }
          .content {
            padding: 20px;
          }
          .invoice-header {
            margin-bottom: 20px;
          }
          .invoice-title {
            font-size: 16px;
            color: #666;
            font-weight: normal;
            margin: 0 0 10px 0;
          }
          .amount {
            font-size: 36px;
            font-weight: 600;
            margin: 0 0 5px 0;
          }
          .date {
            color: #666;
            margin: 0;
          }
          .divider {
            height: 1px;
            background-color: #e6e6e6;
            margin: 20px 0;
          }
          .download-links {
            margin-bottom: 20px;
          }
          .download-link {
            color: #635bff;
            text-decoration: none;
            display: inline-block;
            margin-right: 20px;
          }
          .download-link svg {
            vertical-align: middle;
            margin-right: 5px;
          }
          .info-table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 20px;
          }
          .info-table td {
            padding: 10px 0;
            vertical-align: top;
          }
          .info-table td:first-child {
            color: #666;
            width: 40%;
          }
          .info-table td:last-child {
            text-align: right;
            font-weight: 500;
          }
          .invoice-details {
            margin-top: 30px;
          }
          .invoice-item {
            display: flex;
            justify-content: space-between;
            margin-bottom: 10px;
          }
          .invoice-item-description {
            flex: 1;
          }
          .invoice-item-qty {
            width: 50px;
            text-align: center;
          }
          .invoice-item-amount {
            width: 100px;
            text-align: right;
            font-weight: 500;
          }
          .invoice-total {
            margin-top: 20px;
            border-top: 1px solid #e6e6e6;
            padding-top: 20px;
          }
          .invoice-total-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 10px;
          }
          .invoice-total-label {
            color: #666;
          }
          .invoice-total-amount {
            font-weight: 500;
          }
          .footer {
            text-align: center;
            color: #666;
            font-size: 13px;
            margin-top: 30px;
          }
          .footer a {
            color: #635bff;
            text-decoration: none;
          }
          .powered-by {
            text-align: center;
            margin-top: 20px;
            color: #666;
            font-size: 13px;
          }
          .powered-by img {
            height: 20px;
            vertical-align: middle;
          }
          @media (max-width: 600px) {
            .wrapper {
              padding: 20px 10px;
            }
            .amount {
              font-size: 30px;
            }
          }
        </style>
      </head>
      <body>
        <div class="wrapper">
          <!-- Company Header -->
          <div class="header">
            ${
              logoUrl
                ? `<img src="${logoUrl}" alt="${companyName}" class="logo">`
                : `<h1 class="company-name">${companyName}</h1>`
            }
          </div>
          
          <!-- Main invoice Container -->
          <div class="container">
            <div class="content">
              <!-- invoice Header -->
              <div class="invoice-header">
                <h2 class="invoice-title">Invoice from ${companyName}</h2>
                <h1 class="amount">${formattedAmount}</h1>
                <p class="date">Paid ${chargeDate}</p>
              </div>
              
              <div class="divider"></div>
              
              <!-- Invoice Information -->
              <table class="info-table">
                <tr>
                  <td>Invoice number</td>
                  <td>${invoiceNumber}</td>
                </tr>
                <tr>
                  <td>Payment method</td>
                  <td>
                    ${paymentMethodDisplay}
                    ${lastFour ? ` - ${lastFour}` : ""}
                  </td>
                </tr>
              </table>
              
              <!-- invoice Details -->
              <div class="invoice-details">
                ${billingPeriod ? `<h3 style="margin-top: 0; color: #666; font-weight: normal; font-size: 14px;">${billingPeriod}</h3>` : ""}
                
                <!-- Item Details -->
                <div class="invoice-item">
                  <div class="invoice-item-description">
                    ${subscriptionInfo ? subscriptionInfo.planName : chargeData.description || "Charge"}
                  </div>
                  <div class="invoice-item-qty">1</div>
                  <div class="invoice-item-amount">${formattedAmount}</div>
                </div>
                
                ${
                  false
                    ? `<div style="color: #666; font-size: 14px; margin: 10px 0;">Tax to be paid on reverse charge basis</div>`
                    : ""
                }
                
                <!-- Totals -->
                <div class="invoice-total">
                  <div class="invoice-total-row">
                    <div class="invoice-total-label">Subtotal</div>
                    <div class="invoice-total-amount">${formattedAmount}</div>
                  </div>
                  
                  <div class="invoice-total-row">
                    <div class="invoice-total-label">Total</div>
                    <div class="invoice-total-amount">${formattedAmount}</div>
                  </div>
                  
                  <div class="invoice-total-row">
                    <div class="invoice-total-label">Amount paid</div>
                    <div class="invoice-total-amount">${formattedAmount}</div>
                  </div>
                </div>
              </div>
              
              <!-- Contact Information -->
              <div style="margin-top: 30px; color: #666; font-size: 14px;">
                Questions? Contact us at <a href="mailto:${companyEmail}" style="color: #635bff; text-decoration: none;">${companyEmail}</a>
              </div>

              <div style="margin-top: 20px; font-size: 14px;">
                <a href="https://${c.env.APP_DOMAIN}/billing/${customerId}" style="color: #635bff; text-decoration: none;">View all past invoices</a>
              </div>
            </div>
          </div>
        </div>
      </body>
    </html>
  `

  console.log("Generating PDF using jsPDF")
  // Use the createInvoicePDF function from pdf.ts
  const pdfBuffer = await createInvoicePDF(
    c,
    companyInfo,
    { name: name, email: email, address: customerData.address, vatId: customerData.vatId },
    invoiceNumber,
    chargeData,
    subscriptionInfo,
  )

  console.log("Sending email to", recipientEmail)
  await sendEmail(c, c.env.SENDGRID_FROM, recipientEmail, `Invoice from ${companyName}`, emailContent, [
    {
      filename: `invoice_${invoiceNumber}.pdf`,
      content: pdfBuffer.toString("base64"),
      mimeType: "application/pdf",
    },
  ])

  console.log(`Email sent to ${recipientEmail} with invoice #${invoiceNumber}`)
  return 
}

// Add function to format date in words
function formatDateInWords(date: Date): string {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const day = date.getDate();
  const month = months[date.getMonth()];
  const year = date.getFullYear();
  return `${month} ${day}, ${year}`;
}
