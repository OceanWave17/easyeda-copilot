import test from 'node:test';
import assert from 'node:assert/strict';
import {
    compareNetlist, compareReadback, matchesAny, parseProtelNetlist, readbackToExpected,
    similarNetNames, unannotatedDesignators,
} from '../src/utils/netlist.ts';

// Shape of EasyEDA's Protel 2 export; part types may contain parentheses.
const NETLIST = [
    'PROTEL NETLIST 2.0',
    '[', 'DESIGNATOR', 'U401', 'FOOTPRINT', 'SSOP-4', 'PARTTYPE', 'EL3H7(B)(TA)-G_C5213653', ']',
    '[', 'DESIGNATOR', 'R441', 'FOOTPRINT', 'R0603', 'PARTTYPE', '0603WAF1001T5E', ']',
    '[', 'DESIGNATOR', 'U201', 'FOOTPRINT', 'LQFP-100', 'PARTTYPE', 'STM32F103VCT6', ']',
    '(', 'A_01 ', 'U401-1 EL3H7(B)(TA)-G_C5213653-Anode Passive ', ')',
    '(', 'IN_PD9 ', 'R441-2 0603WAF1001T5E-2 Input   ', 'U201-56 STM32F103VCT6-PD9 Passive ', ')',
    '(', 'VSS ', 'U401-3 EL3H7(B)(TA)-G_C5213653-Emitter Passive ', ')',
].join('\r\n');

test('parses components and nets despite parentheses in part types', () => {
    const parsed = parseProtelNetlist(NETLIST);
    assert.deepEqual(parsed.components, ['U401', 'R441', 'U201']);
    assert.deepEqual(parsed.nets.IN_PD9, ['R441-2', 'U201-56']);
    assert.deepEqual(parsed.nets.VSS, ['U401-3']);
    assert.deepEqual(Object.keys(parsed.nets).sort(), ['A_01', 'IN_PD9', 'VSS']);
});

test('netlist comparison reports wrong nets, unconnected pins and missing parts', () => {
    const parsed = parseProtelNetlist(NETLIST);
    const ok = compareNetlist({ U401: { 1: 'A_01', 3: 'VSS', 4: '' }, U201: { 56: 'IN_PD9' } }, parsed);
    assert.equal(ok.ok, true);
    assert.equal(ok.checked_pins, 4);

    const bad = compareNetlist({ U401: { 1: 'A_02', 2: 'F_XHOME' }, C401: { 1: 'IN_PD9' } }, parsed);
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.missing_components, ['C401']);
    assert.deepEqual(bad.mismatches, [
        { designator: 'U401', pin: '1', expected: 'A_02', actual: 'A_01' },
        { designator: 'U401', pin: '2', expected: 'F_XHOME', actual: '' },
    ]);
});

test('readback comparison catches the silent-failure case: every pin unconnected', () => {
    const readback = [{ designator: 'U1', pins: [{ pin_number: '1', signal_name: '' }, { pin_number: 2, signal_name: '' }] }];
    const result = compareReadback({ U401: { 1: 'A_01' }, U1: { 1: 'A_01', 2: 'F_XHOME' } }, readback);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing_components, ['U401']);
    assert.equal(result.mismatches.length, 2);
});

test('readback round-trips into an expectation', () => {
    const readback = [{ designator: 'R1.1', pins: [{ pin_number: 1, signal_name: 'VDD' }, { pin_number: '2', signal_name: null }] }];
    assert.deepEqual(readbackToExpected(readback), { R1: { 1: 'VDD', 2: '' } });
});

test('flags unannotated designators', () => {
    assert.deepEqual(unannotatedDesignators([{ designator: 'U?', pins: [] }, { designator: 'R12', pins: [] }]), ['U?']);
});

test('glob matching for expected-open nets', () => {
    assert.equal(matchesAny('F_XHOME', ['F_*']), true);
    assert.equal(matchesAny('IN_PD9', ['F_*', 'X_?UL']), false);
    assert.equal(matchesAny('X_PUL', ['X_?UL']), true);
});

test('similar net names group case and punctuation variants but keep signs apart', () => {
    const groups = similarNetNames(['VSS', 'Vss', '+24V', '-24V', 'RS485_A', 'RS485-A', '$1N15', 'VDD']);
    assert.deepEqual(groups, [['VSS', 'Vss'], ['RS485-A', 'RS485_A']]);
});
