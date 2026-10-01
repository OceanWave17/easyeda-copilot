import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { readFile } from 'node:fs/promises';
import * as z from 'zod/v4';
import type { ExecuteJsWireResult } from '@copilot/shared/types/execute-js';
import type { ExplainCircuit } from '@copilot/shared/types/circuit';
import { Bridge } from "../bridge";
import { textResult } from "../utils/tool-result";
import { toolHandler } from './handler';
import {
    compareNetlist, type ExpectedNetlist, limited, matchesAny, parseProtelNetlist, similarNetNames,
} from '../utils/netlist';

const ExpectedNetlistStruct = z.record(z.string().min(1), z.record(z.string().min(1), z.string()));

/** Run a read-only snippet in EasyEDA and return its JSON result. */
async function evaluate(bridge: Pick<Bridge, 'requestEasyEda'>, code: string): Promise<unknown> {
    const reply = await bridge.requestEasyEda('execute-js', { code, inputs: {} }) as ExecuteJsWireResult;
    if (reply.error) throw new Error(`EasyEDA ${reply.error.phase} error: ${reply.error.message}`);
    if (reply.result?.kind !== 'json') throw new Error('EasyEDA returned no JSON result.');
    return JSON.parse(reply.result.json);
}

/** EasyEDA's own whole-schematic netlist, the reference for cross-page connectivity. */
export async function readSchematicNetlist(bridge: Pick<Bridge, 'requestEasyEda'>) {
    const text = await evaluate(bridge, "return await eda.sch_Netlist.getNetlist('Protel2');");
    if (typeof text !== 'string' || !text.includes('(')) throw new Error('EasyEDA returned an empty netlist.');
    return parseProtelNetlist(text);
}

export function registerVerifyTools(server: McpServer, bridge: Bridge) {
    server.registerTool(
        'verify_netlist',
        {
            title: 'Verify Schematic Netlist',
            description: 'Compare expected pin connections with EasyEDA\'s own netlist for the whole schematic (all pages, so cross-page nets are included). '
                + 'Provide expected as {designator: {pin_number: net_name}} inline or as a JSON file_path; use "" for an intentionally unconnected pin. '
                + 'Only listed components and pins are checked. Returns ok, counts, missing_components and per-pin mismatches. Use after every schematic change.',
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            inputSchema: z.object({
                expected: ExpectedNetlistStruct.optional()
                    .describe('Expected connections: {designator: {pin_number: net_name}}.'),
                file_path: z.string().min(1).optional()
                    .describe('Absolute path to a UTF-8 JSON file with the same structure as expected.'),
                limit: z.number().int().min(1).max(500).default(50)
                    .describe('Maximum mismatches to return; the full count is always reported.'),
            }),
        },
        toolHandler(bridge, async ({ expected, file_path, limit }) => {
            if ((expected === undefined) === (file_path === undefined)) {
                throw new Error('Provide exactly one of expected or file_path.');
            }
            const want: ExpectedNetlist = ExpectedNetlistStruct.parse(file_path !== undefined
                ? JSON.parse(await readFile(file_path, 'utf8'))
                : expected);
            const comparison = compareNetlist(want, await readSchematicNetlist(bridge));
            const result = {
                ok: comparison.ok,
                checked_components: comparison.checked_components,
                checked_pins: comparison.checked_pins,
                missing_components: comparison.missing_components,
                mismatches: limited(comparison.mismatches, limit),
            };
            return { ...await textResult(result), ...(comparison.ok ? {} : { isError: true }) };
        }),
    );

    server.registerTool(
        'check_schematic',
        {
            title: 'Check Schematic (ERC)',
            description: 'Run native EasyEDA schematic ERC (pass/fail and counts) plus netlist checks across all pages: single-pin nets, '
                + 'unconnected component pins, and net names that differ only by case or punctuation (likely typos). '
                + 'expected_open lists glob patterns (e.g. "F_*") for nets that are intentionally open until another page is drawn; '
                + 'they are reported separately. Read-only.',
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            inputSchema: z.object({
                expected_open: z.array(z.string().min(1)).default([])
                    .describe('Glob patterns of nets expected to have a single pin for now.'),
                limit: z.number().int().min(1).max(500).default(60)
                    .describe('Maximum items per list; full counts are always reported.'),
            }),
        },
        toolHandler(bridge, async ({ expected_open, limit }) => {
            const erc = await evaluate(bridge, 'return await eda.sch_Drc.check(true, false, true);');
            const netlist = await readSchematicNetlist(bridge);
            const schematic = await bridge.requestEasyEda('get-multi-page-schematic') as ExplainCircuit;

            const singles = Object.entries(netlist.nets)
                .filter(([, members]) => members.length === 1)
                .map(([net, members]) => ({ net, pin: members[0] }));
            const unexpectedSingles = singles.filter(single => !matchesAny(single.net, expected_open));
            const expectedSingles = singles.filter(single => matchesAny(single.net, expected_open));

            const unconnected: Record<string, string[]> = {};
            for (const component of schematic.components) {
                const open = component.pins
                    .filter(pin => !pin.signal_name)
                    .map(pin => String(pin.pin_number));
                if (open.length) unconnected[component.designator] = open;
            }
            const unconnectedCount = Object.values(unconnected).reduce((sum, pins) => sum + pins.length, 0);
            const similar = similarNetNames(Object.keys(netlist.nets));

            const result = {
                erc_native: erc,
                summary: {
                    components: netlist.components.length,
                    nets: Object.keys(netlist.nets).length,
                    single_pin_nets: unexpectedSingles.length,
                    expected_open_nets: expectedSingles.length,
                    unconnected_pins: unconnectedCount,
                    similar_net_name_groups: similar.length,
                },
                single_pin_nets: limited(unexpectedSingles, limit),
                expected_open_nets: limited(expectedSingles.map(single => single.net), limit),
                unconnected_pins: unconnected,
                similar_net_names: similar,
            };
            return textResult(result);
        }),
    );
}
