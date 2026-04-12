#!/usr/bin/env node
/**
 * Re-embed all support_kb records using summary_problem + summary_solution
 * instead of full_dialog. This dramatically improves retrieval quality.
 *
 * Usage: node scripts/reembed.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const ai = require('../src/services/ai');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const BATCH_SIZE = 5; // concurrent requests
const DELAY_MS = 500; // delay between batches to avoid rate limits

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  // Fetch all records
  const { data: records, error } = await supabase
    .from('support_kb')
    .select('id, summary_problem, summary_solution')
    .order('created_at');

  if (error) {
    console.error('Failed to fetch records:', error.message);
    process.exit(1);
  }

  console.log(`Total records to re-embed: ${records.length}`);

  let done = 0;
  let failed = 0;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async (r) => {
        const text = `${r.summary_problem || ''} ${r.summary_solution || ''}`.trim();
        if (!text || text.length < 10) {
          return { id: r.id, skip: true };
        }

        const embedding = await ai.generateEmbedding(text);

        const { error: updateErr } = await supabase
          .from('support_kb')
          .update({ embedding })
          .eq('id', r.id);

        if (updateErr) throw new Error(`Update ${r.id}: ${updateErr.message}`);
        return { id: r.id, skip: false };
      })
    );

    for (const res of results) {
      if (res.status === 'fulfilled' && !res.value.skip) done++;
      else if (res.status === 'rejected') {
        failed++;
        console.error(`  FAILED:`, res.reason.message);
      }
    }

    process.stdout.write(`\r  ${done + failed}/${records.length} (${done} ok, ${failed} failed)`);

    if (i + BATCH_SIZE < records.length) {
      await sleep(DELAY_MS);
    }
  }

  console.log(`\n\nDone. Re-embedded: ${done}, failed: ${failed}, total: ${records.length}`);
}

main().catch(e => console.error(e));
