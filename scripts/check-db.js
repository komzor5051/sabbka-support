#!/usr/bin/env node
/**
 * Quick check: what's already in support_kb?
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function main() {
  // Count existing records
  const { count, error: countErr } = await supabase
    .from('support_kb')
    .select('*', { count: 'exact', head: true });

  if (countErr) {
    console.error('Error counting:', countErr.message);
    return;
  }
  console.log(`Existing records in support_kb: ${count}`);

  // Sample a few
  const { data, error } = await supabase
    .from('support_kb')
    .select('id, created_at, category, summary_problem')
    .order('created_at', { ascending: false })
    .limit(5);

  if (error) {
    console.error('Error fetching:', error.message);
    return;
  }

  console.log('\nLatest 5 records:');
  for (const r of data) {
    const date = new Date(r.created_at).toLocaleDateString('ru-RU');
    const prob = (r.summary_problem || '').substring(0, 80);
    console.log(`  [${date}] ${r.category} — ${prob}...`);
  }

  // Categories
  const { data: cats } = await supabase
    .from('kb_categories')
    .select('name, description');
  console.log('\nCategories:', cats?.map(c => c.name).join(', '));

  // Try insert + delete to test write access
  console.log('\nTesting write access...');
  const { data: testRow, error: insertErr } = await supabase
    .from('support_kb')
    .insert({
      category: 'прочее',
      full_dialog: '__test__',
      summary_problem: '__test__',
      summary_solution: '__test__',
    })
    .select('id')
    .single();

  if (insertErr) {
    console.error('Write test FAILED:', insertErr.message);
    console.error('Detail:', insertErr.details || insertErr.hint || '');
  } else {
    console.log('Write test OK, cleaning up...');
    await supabase.from('support_kb').delete().eq('id', testRow.id);
    console.log('Cleanup OK');
  }
}

main().catch(e => console.error(e));
