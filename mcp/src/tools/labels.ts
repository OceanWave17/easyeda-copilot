import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import * as z from 'zod/v4';
import type { ExecuteJsWireResult } from '@copilot/shared/types/execute-js';
import type { ExplainCircuit } from '@copilot/shared/types/circuit';
import { Bridge } from "../bridge";
import { textResult } from "../utils/tool-result";
import { compareReadback, readbackToExpected } from '../utils/netlist';
import { managedMutationHandler } from './handler';
import TIDY_LABELS_SCRIPT from './tidy-labels.js.txt';

export function registerLabelTools(server: McpServer, bridge: Bridge) {
    server.registerTool(
        'tidy_labels',
        {
            title: 'Tidy Schematic Labels',
            description: 'Resolve overlapping text on the current schematic page without changing connectivity: hide a wire\'s net-name text '
                + 'when a port or flag of the same net already sits on that wire, then move remaining overlapping designators, values and '
                + 'wire net names to the nearest free spot. Ports, flags, symbols and wires never move. Run after beautify. '
                + 'dry_run reports what would change. Saves a checkpoint and verifies page connectivity is unchanged.',
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            inputSchema: z.object({
                dry_run: z.boolean().default(false).describe('Report the planned changes without applying them.'),
                max_shift: z.number().min(5).max(200).default(40).describe('Largest move per text, in schematic units.'),
                step: z.number().min(1).max(20).default(5).describe('Search grid for new text positions, in schematic units.'),
            }),
        },
        managedMutationHandler(bridge, 'tidy_labels', async ({ dry_run, max_shift, step }) => {
            const before = await bridge.requestEasyEda('get-schematic') as ExplainCircuit;
            const reply = await bridge.requestEasyEda('execute-js', {
                code: TIDY_LABELS_SCRIPT,
                inputs: { options: JSON.stringify({ dryRun: dry_run, maxShift: max_shift, step }) },
            }) as ExecuteJsWireResult;
            if (reply.error) throw new Error(`EasyEDA ${reply.error.phase} error: ${reply.error.message}`);
            if (reply.result?.kind !== 'json') throw new Error('EasyEDA returned no label result.');
            const labels = JSON.parse(reply.result.json);

            const after = await bridge.requestEasyEda('get-schematic') as ExplainCircuit;
            const connectivity = compareReadback(readbackToExpected(before.components), after.components);
            const result = {
                ...labels,
                checkpointId: reply.checkpoint,
                connectivity_unchanged: connectivity.ok,
                ...(connectivity.ok ? {} : { mismatches: connectivity.mismatches.slice(0, 40) }),
            };
            return { ...await textResult(result), ...(connectivity.ok ? {} : { isError: true }) };
        }),
    );
}
