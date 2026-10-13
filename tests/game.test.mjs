import test from 'node:test';
import assert from 'node:assert/strict';

function scoreRound(playerIds, suspectId, caught, guessedCorrectly) {
  return Object.fromEntries(playerIds.map(id => [id, id === suspectId ? (!caught ? 2 : guessedCorrectly ? 3 : 0) : (caught && !guessedCorrectly ? 2 : 0)]));
}
const ids = ['detective-a', 'suspect', 'detective-b'];

test('suspect earns 2 points when escaping detection', () => {
  assert.deepEqual(scoreRound(ids, 'suspect', false, null), { 'detective-a': 0, suspect: 2, 'detective-b': 0 });
});
test('suspect earns 3 points when caught but guessing the detective word', () => {
  assert.deepEqual(scoreRound(ids, 'suspect', true, true), { 'detective-a': 0, suspect: 3, 'detective-b': 0 });
});
test('detectives each earn 2 points when the caught suspect misses', () => {
  assert.deepEqual(scoreRound(ids, 'suspect', true, false), { 'detective-a': 2, suspect: 0, 'detective-b': 2 });
});
