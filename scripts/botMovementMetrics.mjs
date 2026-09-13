/** Paired trials must cover the same fixture, dice, timestep, speed and start offset. */
const key = r => JSON.stringify([r.fixture, r.seed, r.hz, r.speed, r.offset]);

export function movementRegressions(before, after) {
  for (const row of [...before, ...after]) {
    for (const field of ['hz', 'elapsed', 'loss', 'longestStall', 'engageTime']) {
      if (!Number.isFinite(row[field]) || row[field] < 0) throw new Error(`Invalid movement metric ${field}`);
    }
    if (row.hz === 0) throw new Error('Invalid movement metric hz');
  }
  const baseline = new Map(before.map(r => [key(r), r]));
  if (baseline.size !== before.length) throw new Error('Duplicate baseline movement trial');
  const seen = new Set();
  const failures = [];
  for (const row of after) {
    const id = key(row), old = baseline.get(id);
    if (!old || seen.has(id)) throw new Error(`Unpaired or duplicate movement trial: ${id}`);
    seen.add(id);
    const fail = message => failures.push(`${id}: ${message}`);
    if (!row.engage && !row.arrived) fail('did not arrive');
    // Half a percentage point allows a few frame-quantized brushes, not grinding.
    if (row.loss > old.loss + 0.005) fail('collision loss increased by more than 0.5 percentage points');
    if (row.longestStall > old.longestStall + 0.05) fail('longest stall increased by more than one clamped frame');
    if (!row.engage && old.arrived && row.elapsed > old.elapsed * 1.1 + 1 / row.hz)
      fail('travel time increased by more than 10%');
    if (row.engage && row.engageTime < old.engageTime * 0.9) fail('escaped the fixture by abandoning engagement');
    if (old.transportSeen && !row.transportSeen) fail('did not exercise the transport leg');
  }
  if (seen.size !== baseline.size) throw new Error('Missing paired movement trials');
  return failures;
}
