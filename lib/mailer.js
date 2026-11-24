'use strict';
/**
 * Email alerts, sent through Brevo's HTTPS API.
 * (Render's free plan blocks normal SMTP email ports, so an HTTPS API is the reliable way.)
 *
 * If the settings below are missing, emails are simply skipped and the site keeps working.
 *
 *   BREVO_API_KEY    API key from Brevo (SMTP & API > API Keys)
 *   MAIL_FROM        the verified sender address in Brevo
 *   MAIL_FROM_NAME   optional, defaults to "RSM Student Accommodation"
 *   LANDLORD_EMAILS  comma-separated list of addresses that get the "new booking" alert
 *   SITE_URL         e.g. https://rsm-student-accommodation.onrender.com
 */
const API = process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email';
const KEY = process.env.BREVO_API_KEY || '';
const FROM = process.env.MAIL_FROM || '';
const FROM_NAME = process.env.MAIL_FROM_NAME || 'RSM Student Accommodation';
const OWNERS = (process.env.LANDLORD_EMAILS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SITE = (process.env.SITE_URL || '').replace(/\/+$/, '');

const enabled = !!(KEY && FROM && OWNERS.length);

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

async function send({ to, subject, html, text, replyTo }) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'api-key': KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: FROM, name: FROM_NAME },
      to,
      subject,
      htmlContent: html,
      textContent: text,
      ...(replyTo ? { replyTo: { email: replyTo } } : {}),
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/* --------------------------------- layout --------------------------------- */
function layout(preheader, inner) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f3f5fa;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5fa;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#2b3750;">
<tr><td style="background:#0b1220;padding:22px 28px;">
  <span style="display:inline-block;background:#f5a623;color:#0b1220;font-weight:bold;border-radius:8px;padding:6px 11px;font-size:16px;">R</span>
  <span style="color:#ffffff;font-size:17px;font-weight:bold;margin-left:10px;vertical-align:middle;">RSM <span style="color:#f5a623;">Student Accommodation</span></span>
</td></tr>
<tr><td style="padding:30px 28px 26px;font-size:15px;line-height:1.6;">${inner}</td></tr>
<tr><td style="background:#f8f9fc;padding:16px 28px;font-size:12px;color:#7b8aa3;">RSM Student Accommodation &middot; Thekwane North, Mpumalanga</td></tr>
</table></td></tr></table></body></html>`;
}

const row = (label, value) =>
  `<tr><td style="padding:9px 0;border-bottom:1px solid #e5e9f2;color:#7b8aa3;font-size:13px;width:38%;">${esc(label)}</td>` +
  `<td style="padding:9px 0;border-bottom:1px solid #e5e9f2;font-weight:bold;color:#0b1220;">${value}</td></tr>`;

const when = (d) =>
  new Date(d).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Johannesburg' });

/* -------------------------------- templates -------------------------------- */
function studentEmail(a) {
  const first = a.name.split(' ')[0];
  const subject = `We have received your application, ${first}`;
  const html = layout(
    `Your application for the ${a.room} has been sent.`,
    `<h2 style="margin:0 0 12px;font-size:22px;color:#0b1220;">Application sent, ${esc(first)}!</h2>
<p style="margin:0 0 16px;">Thank you for applying to RSM Student Accommodation. Your application for the <b>${esc(a.room)}</b> has been sent, and we are glad you thought of us.</p>
<p style="margin:0 0 8px;font-weight:bold;color:#0b1220;">What happens next</p>
<ol style="margin:0 0 20px;padding-left:20px;">
  <li style="margin-bottom:6px;">We review your details and ID.</li>
  <li style="margin-bottom:6px;">We contact you within 24 hours on <b>${esc(a.phone)}</b>.</li>
  <li>If your application is approved, we will explain how to secure your room.</li>
</ol>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
  ${row('Room', esc(a.room))}${row('Student number', esc(a.studentNumber))}${row('University', esc(a.university))}
</table>
<p style="margin:0 0 6px;">Please keep your phone close so you do not miss our call or message. If you have a question, just reply to this email.</p>
<p style="margin:18px 0 0;">Warm regards,<br><b>The RSM Student Accommodation team</b></p>`
  );
  const text = [
    `Hi ${first},`,
    '',
    `Thank you for applying to RSM Student Accommodation. Your application for the ${a.room} has been sent, and we are glad you thought of us.`,
    '',
    'What happens next:',
    '1. We review your details and ID.',
    `2. We contact you within 24 hours on ${a.phone}.`,
    '3. If your application is approved, we will explain how to secure your room.',
    '',
    `Room: ${a.room}`,
    `Student number: ${a.studentNumber}`,
    `University: ${a.university}`,
    '',
    'Please keep your phone close so you do not miss our call or message. If you have a question, just reply to this email.',
    '',
    'Warm regards,',
    'The RSM Student Accommodation team',
  ].join('\n');
  return { subject, html, text };
}

function landlordEmail(a) {
  const link = SITE ? `${SITE}/admin` : '';
  const subject = `New booking: ${a.name} applied for the ${a.room}`;
  const button = link
    ? `<p style="margin:22px 0;"><a href="${esc(link)}" style="background:#f5a623;color:#0b1220;text-decoration:none;font-weight:bold;padding:13px 24px;border-radius:50px;display:inline-block;">Review application</a></p>`
    : '';
  const html = layout(
    `${a.name} has booked a room. Review and decide whether to admit them.`,
    `<h2 style="margin:0 0 12px;font-size:22px;color:#0b1220;">Someone has booked a room</h2>
<p style="margin:0 0 16px;"><b>${esc(a.name)}</b> has just applied for the <b>${esc(a.room)}</b>. Please view the application and their ID, then decide whether to admit them.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  ${row('Name', esc(a.name))}${row('Room', esc(a.room))}${row('Student number', esc(a.studentNumber))}
  ${row('University', esc(a.university))}${row('Phone', esc(a.phone))}${row('Email', esc(a.email))}${row('Applied', esc(when(a.createdAt)))}
</table>
${button}
<p style="margin:0;color:#7b8aa3;font-size:13px;">The ID photo is not included in this email for the student's privacy. Open the admin page and log in to view it, then set the status to Contacted, Accepted or Declined. The student has been told to expect your call within 24 hours.</p>`
  );
  const text = [
    'Someone has booked a room.',
    '',
    `${a.name} has just applied for the ${a.room}. Please view the application and their ID, then decide whether to admit them.`,
    '',
    `Name: ${a.name}`,
    `Room: ${a.room}`,
    `Student number: ${a.studentNumber}`,
    `University: ${a.university}`,
    `Phone: ${a.phone}`,
    `Email: ${a.email}`,
    `Applied: ${when(a.createdAt)}`,
    '',
    link ? `Review the application: ${link}` : 'Open the admin page to review the application.',
    '',
    'The ID photo is not included in this email for the student\'s privacy. Log in to the admin page to view it.',
  ].join('\n');
  return { subject, html, text };
}

/* --------------------------------- public API --------------------------------- */
/** Sends both emails. Never throws: a mail problem must never lose an application. */
async function notifyNewApplication(a) {
  if (!enabled) return { skipped: true };
  const app = { ...a, createdAt: a.createdAt || new Date().toISOString() };
  const jobs = [
    send({ to: [{ email: app.email, name: app.name }], replyTo: OWNERS[0], ...studentEmail(app) }),
    send({ to: OWNERS.map((email) => ({ email })), replyTo: app.email, ...landlordEmail(app) }),
  ];
  const results = await Promise.allSettled(jobs);
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`email (${i === 0 ? 'student' : 'landlord'}) failed:`, r.reason.message);
  });
  return { skipped: false };
}

module.exports = { enabled, notifyNewApplication };
