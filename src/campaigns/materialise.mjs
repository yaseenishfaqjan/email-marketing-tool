/**
 * Turn a campaign into rows in `messages` — one per recipient, written before
 * anything is handed to SES.
 *
 * This is the step that makes the send restartable. After it, the campaign is
 * a finite queue of durable rows with a unique constraint on
 * (campaign_id, contact_id); a worker can die at any point and the only cost
 * is the messages that were in flight.
 *
 * It is one INSERT ... SELECT rather than a loop. At 50,000 recipients a loop
 * is 50,000 round trips and a transaction held open for minutes.
 */

import { tx } from '../db.mjs';
import { compileSegment } from '../segments/compile.mjs';
import { NOT_SUPPRESSED_SQL } from '../suppression/repo.mjs';

export class CampaignStateError extends Error {}

export async function materialiseCampaign(campaignId) {
  return tx(async (client) => {
    // Lock the campaign row first. Two schedulers firing the same campaign at
    // the same moment would otherwise both pass the status check.
    const { rows: campaigns } = await client.query(
      'select * from campaigns where id = $1 for update',
      [campaignId],
    );
    const campaign = campaigns[0];
    if (!campaign) throw new CampaignStateError('Campaign not found.');
    if (!['draft', 'scheduled'].includes(campaign.status)) {
      throw new CampaignStateError(
        `Campaign is "${campaign.status}"; only a draft or scheduled campaign can be sent.`,
      );
    }

    let definition = { match: 'all', rules: [] };
    if (campaign.segment_id) {
      const { rows } = await client.query('select definition from segments where id = $1 and brand_id = $2',
        [campaign.segment_id, campaign.brand_id]);
      if (!rows[0]) throw new CampaignStateError('The campaign references a segment that no longer exists.');
      definition = rows[0].definition;
    }

    // $1 campaign id, $2 brand id, then the segment's own parameters.
    const { sql, params } = compileSegment(definition, 3);

    const { rowCount } = await client.query(
      `insert into messages (brand_id, contact_id, campaign_id)
       select c.brand_id, c.id, $1
         from contacts c
        where c.brand_id = $2
          and c.status = 'subscribed'
          and ${sql}
          and ${NOT_SUPPRESSED_SQL}
       on conflict (campaign_id, contact_id) do nothing`,
      [campaignId, campaign.brand_id, ...params],
    );

    await client.query(
      `update campaigns
          set status = $2, started_at = coalesce(started_at, now()), updated_at = now(),
              stats = stats || jsonb_build_object('recipients', $3::int)
        where id = $1`,
      [campaignId, rowCount > 0 ? 'sending' : 'sent', rowCount],
    );

    return { recipients: rowCount };
  });
}

/**
 * Mark a campaign finished once nothing is left to send.
 *
 * Called by the worker after each batch. It is a no-op until the last message
 * leaves the queue, which is what lets several workers share one campaign
 * without any of them having to know how many there are.
 */
export async function finaliseIfDone(campaignId, client) {
  const run = client ? client.query.bind(client) : (await import('../db.mjs')).query;
  const { rows } = await run(
    `select count(*) filter (where status in ('queued','sending'))::int as pending,
            count(*) filter (where status = 'sent' or status = 'delivered')::int as sent,
            count(*) filter (where status = 'failed')::int as failed
       from messages where campaign_id = $1`,
    [campaignId],
  );
  const { pending, sent, failed } = rows[0];
  if (pending > 0) return false;

  await run(
    `update campaigns
        set status = 'sent', sent_at = coalesce(sent_at, now()), updated_at = now(),
            stats = stats || jsonb_build_object('sent', $2::int, 'failed', $3::int)
      where id = $1 and status = 'sending'`,
    [campaignId, sent, failed],
  );
  return true;
}
