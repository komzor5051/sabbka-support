#!/usr/bin/env node
/**
 * Find and remove duplicate entries in support_kb using vector similarity.
 *
 * Algorithm:
 * 1. Fetch all records with embeddings
 * 2. Compute pairwise cosine similarity (O(n²), fine for <1000 records)
 * 3. Build clusters via union-find (connected components of similarity >= threshold)
 * 4. In each cluster, keep the record with the longest summary, archive the rest
 *
 * Usage:
 *   node scripts/deduplicate-kb.js                  # dry-run (report only)
 *   node scripts/deduplicate-kb.js --execute        # actually delete duplicates
 *   node scripts/deduplicate-kb.js --threshold 0.90 # custom threshold (default: 0.92)
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// --- CLI args ---
const args = process.argv.slice(2);
const executeMode = args.includes('--execute');
const thresholdIdx = args.indexOf('--threshold');
const SIMILARITY_THRESHOLD = thresholdIdx !== -1 ? parseFloat(args[thresholdIdx + 1]) : 0.92;

if (isNaN(SIMILARITY_THRESHOLD) || SIMILARITY_THRESHOLD < 0.5 || SIMILARITY_THRESHOLD > 1.0) {
  console.error('Invalid threshold. Must be between 0.5 and 1.0');
  process.exit(1);
}

// --- Cosine similarity ---
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// --- Union-Find ---
class UnionFind {
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
  }

  find(x) {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]); // path compression
    }
    return this.parent[x];
  }

  union(x, y) {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return;
    if (this.rank[rx] < this.rank[ry]) { this.parent[rx] = ry; }
    else if (this.rank[rx] > this.rank[ry]) { this.parent[ry] = rx; }
    else { this.parent[ry] = rx; this.rank[rx]++; }
  }
}

// --- Score: higher = better record to keep ---
function recordScore(record) {
  const problemLen = (record.summary_problem || '').length;
  const solutionLen = (record.summary_solution || '').length;
  return problemLen + solutionLen;
}

async function main() {
  console.log(`\nDeduplicate KB — threshold: ${SIMILARITY_THRESHOLD}, mode: ${executeMode ? 'EXECUTE' : 'DRY-RUN'}\n`);

  // 1. Fetch all records with embeddings
  console.log('Fetching records...');
  const { data: records, error } = await supabase
    .from('support_kb')
    .select('id, created_at, category, summary_problem, summary_solution, embedding')
    .not('embedding', 'is', null)
    .order('created_at');

  if (error) {
    console.error('Failed to fetch records:', error.message);
    process.exit(1);
  }

  console.log(`Loaded ${records.length} records with embeddings\n`);

  if (records.length < 2) {
    console.log('Not enough records to check for duplicates.');
    return;
  }

  // Parse embeddings (Supabase returns them as strings like "[0.1,0.2,...]")
  for (const r of records) {
    if (typeof r.embedding === 'string') {
      r.embedding = JSON.parse(r.embedding);
    }
  }

  // 2. Compute pairwise similarities, build union-find
  console.log('Computing pairwise similarities...');
  const n = records.length;
  const uf = new UnionFind(n);
  let pairsFound = 0;
  const duplicatePairs = [];

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim = cosineSimilarity(records[i].embedding, records[j].embedding);
      if (sim >= SIMILARITY_THRESHOLD) {
        uf.union(i, j);
        pairsFound++;
        duplicatePairs.push({ i, j, similarity: sim });
      }
    }

    // Progress for large sets
    if ((i + 1) % 50 === 0) {
      process.stdout.write(`\r  Compared ${i + 1}/${n} records...`);
    }
  }
  console.log(`\r  Compared ${n}/${n} records — found ${pairsFound} similar pairs\n`);

  if (pairsFound === 0) {
    console.log('No duplicates found. KB is clean!');
    return;
  }

  // 3. Build clusters from union-find
  const clusters = new Map(); // root -> [indices]
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(i);
  }

  // Filter to only multi-record clusters
  const dupClusters = [...clusters.values()].filter(c => c.length > 1);
  console.log(`Found ${dupClusters.length} duplicate cluster(s):\n`);

  const toDelete = [];

  for (let ci = 0; ci < dupClusters.length; ci++) {
    const cluster = dupClusters[ci];

    // Sort by score descending — first one is the "best" to keep
    cluster.sort((a, b) => recordScore(records[b]) - recordScore(records[a]));

    const keepIdx = cluster[0];
    const keep = records[keepIdx];
    const removeIndices = cluster.slice(1);

    console.log(`--- Cluster ${ci + 1} (${cluster.length} records) ---`);
    console.log(`  KEEP: [${keep.id.substring(0, 8)}] ${keep.category} | ${(keep.summary_problem || '').substring(0, 80)}...`);
    console.log(`        score: ${recordScore(keep)} chars`);

    for (const ri of removeIndices) {
      const r = records[ri];
      const sim = cosineSimilarity(keep.embedding, r.embedding);
      console.log(`  DEL:  [${r.id.substring(0, 8)}] ${r.category} | ${(r.summary_problem || '').substring(0, 80)}...`);
      console.log(`        score: ${recordScore(r)} chars, similarity: ${(sim * 100).toFixed(1)}%`);
      toDelete.push(r.id);
    }
    console.log();
  }

  // 4. Summary
  console.log(`\n=== SUMMARY ===`);
  console.log(`Total records: ${records.length}`);
  console.log(`Duplicate clusters: ${dupClusters.length}`);
  console.log(`Records to keep: ${records.length - toDelete.length}`);
  console.log(`Records to delete: ${toDelete.length}`);
  console.log(`Savings: ${((toDelete.length / records.length) * 100).toFixed(1)}%\n`);

  // 5. Execute deletion if flag is set
  if (!executeMode) {
    console.log('DRY-RUN complete. Run with --execute to delete duplicates.');
    return;
  }

  console.log('Deleting duplicates...');
  let deleted = 0;
  let failed = 0;

  // Delete in batches of 20
  for (let i = 0; i < toDelete.length; i += 20) {
    const batch = toDelete.slice(i, i + 20);
    const { error: delError } = await supabase
      .from('support_kb')
      .delete()
      .in('id', batch);

    if (delError) {
      console.error(`  Failed to delete batch: ${delError.message}`);
      failed += batch.length;
    } else {
      deleted += batch.length;
    }
  }

  console.log(`\nDeleted: ${deleted}, failed: ${failed}`);
  console.log('Done. Remaining records:', records.length - deleted);
}

main().catch(e => { console.error(e); process.exit(1); });
