/**
 * The starter templates every brand begins with.
 *
 * Four, not forty. A library nobody wrote is a library nobody trusts, and
 * these cover what these businesses actually send: an announcement, a plain
 * letter, an onboarding step, and a receipt-shaped transactional layout.
 *
 * All four are single-column. Multi-column email is where Outlook goes wrong,
 * and on a phone the columns stack anyway — so the second column only ever
 * costs you the rendering bug.
 */

export const STARTERS = [
  {
    name: 'Plain letter',
    category: 'newsletter',
    description: 'Text only, no images. The highest-deliverability shape there is, and it reads as written by a person.',
    subject: 'A note from {{attrs.company}}',
    preheader: 'A short, personal update.',
    mjml: `<mjml>
  <mj-head>
    <mj-attributes>
      <mj-text font-family="Georgia, 'Times New Roman', serif" font-size="16px" line-height="1.65" color="#2e2a26" />
      <mj-section background-color="#ffffff" padding="0 24px" />
    </mj-attributes>
  </mj-head>
  <mj-body background-color="#f7f5f1" width="560px">
    <mj-section padding-top="32px">
      <mj-column>
        <mj-text font-size="15px" color="#8a8177" padding-bottom="20px">{{attrs.company}}</mj-text>
        <mj-text>Hi {{first_name}},</mj-text>
        <mj-text>Write the email here as you would write it to one person. Short
        paragraphs, one idea each, and one thing to do at the end.</mj-text>
        <mj-text>— The team</mj-text>
      </mj-column>
    </mj-section>
    <mj-section padding-bottom="32px">
      <mj-column>
        <mj-text font-size="14px"><a href="https://example.com" style="color:#9a7b4f;">The one link that matters</a></mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`,
  },
  {
    name: 'Announcement',
    category: 'product',
    description: 'A heading, a paragraph, one button. For shipping something.',
    subject: 'Introducing {{attrs.feature}}',
    preheader: 'The thing you asked for, in one line.',
    mjml: `<mjml>
  <mj-head>
    <mj-attributes>
      <mj-text font-family="Helvetica, Arial, sans-serif" font-size="16px" line-height="1.6" color="#2e2a26" />
      <mj-section background-color="#ffffff" padding="0 24px" />
    </mj-attributes>
  </mj-head>
  <mj-body background-color="#f2f4f7" width="600px">
    <mj-section padding="32px 24px 8px">
      <mj-column>
        <mj-text font-size="26px" font-weight="700" line-height="1.25">Something new</mj-text>
        <mj-text>One paragraph on what it is and who it helps. Resist the urge to
        list everything — the link can do that.</mj-text>
        <mj-button href="https://example.com" background-color="#141210" border-radius="6px"
                   font-size="15px" padding="20px 0 8px">See what changed</mj-button>
      </mj-column>
    </mj-section>
    <mj-section padding="0 24px 32px">
      <mj-column>
        <mj-divider border-color="#e6e2dc" border-width="1px" />
        <mj-text font-size="14px" color="#6b655e">Not interested in product news?
        Use the unsubscribe link below — it takes one click.</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`,
  },
  {
    name: 'Onboarding step',
    category: 'automation',
    description: 'One instruction and one button. Built for a drip sequence, where every extra word costs a reader.',
    subject: 'Step one: {{attrs.step}}',
    preheader: 'Two minutes, and the rest gets easier.',
    mjml: `<mjml>
  <mj-head>
    <mj-attributes>
      <mj-text font-family="Helvetica, Arial, sans-serif" font-size="16px" line-height="1.6" color="#2e2a26" />
      <mj-section background-color="#ffffff" padding="0 24px" />
    </mj-attributes>
  </mj-head>
  <mj-body background-color="#ffffff" width="560px">
    <mj-section padding="32px 24px 0">
      <mj-column>
        <mj-text>Hi {{first_name}},</mj-text>
        <mj-text font-size="20px" font-weight="600" padding-top="8px">Do this one thing</mj-text>
        <mj-text>Say what to do and why it is worth two minutes. One step per
        email — a list of six is a list nobody starts.</mj-text>
        <mj-button href="https://example.com" background-color="#1a7f5a" border-radius="6px"
                   font-size="15px" padding="16px 0 24px">Do it now</mj-button>
        <mj-text font-size="14px" color="#6b655e">Stuck? Reply to this email —
        a person reads it.</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`,
  },
  {
    name: 'Receipt',
    category: 'transactional',
    description: 'A details table. For order confirmations and anything a customer keeps for their records.',
    subject: 'Your receipt from {{attrs.company}}',
    preheader: 'Keep this for your records.',
    mjml: `<mjml>
  <mj-head>
    <mj-attributes>
      <mj-text font-family="Helvetica, Arial, sans-serif" font-size="15px" line-height="1.6" color="#2e2a26" />
      <mj-section background-color="#ffffff" padding="0 24px" />
    </mj-attributes>
  </mj-head>
  <mj-body background-color="#f7f5f1" width="560px">
    <mj-section padding="32px 24px 8px">
      <mj-column>
        <mj-text font-size="20px" font-weight="600">Thank you — payment received</mj-text>
        <mj-text>Hi {{first_name}}, here is your receipt.</mj-text>
        <mj-table font-size="14px">
          <tr style="border-bottom:1px solid #eee7dc;text-align:left;">
            <th style="padding:10px 0;color:#8a8177;font-weight:400;width:42%;">Reference</th>
            <td style="padding:10px 0;font-weight:700;">{{attrs.reference}}</td>
          </tr>
          <tr style="border-bottom:1px solid #eee7dc;text-align:left;">
            <th style="padding:10px 0;color:#8a8177;font-weight:400;">Item</th>
            <td style="padding:10px 0;">{{attrs.item}}</td>
          </tr>
          <tr style="border-bottom:1px solid #eee7dc;text-align:left;">
            <th style="padding:10px 0;color:#8a8177;font-weight:400;">Amount paid</th>
            <td style="padding:10px 0;font-weight:700;">{{attrs.amount}}</td>
          </tr>
        </mj-table>
        <mj-text font-size="13px" color="#8a8177" padding-top="16px">
          Questions about this order? Reply to this email quoting {{attrs.reference}}.
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`,
  },
];
