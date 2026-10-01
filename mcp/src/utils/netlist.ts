/**
 * Netlist parsing and comparison used to verify schematic changes against an
 * explicit expectation, independent of the assembly that produced them.
 */

/** Expected connections: designator -> pin number -> net name ('' = intentionally unconnected). */
export type ExpectedNetlist = Record<string, Record<string, string>>;

export type ParsedNetlist = {
    /** Net name -> members as "DESIGNATOR-PIN". */
    nets: Record<string, string[]>;
    /** Designators declared in the component section. */
    components: string[];
};

export type NetlistMismatch = {
    designator: string;
    pin: string;
    expected: string;
    actual: string;
};

export type NetlistComparison = {
    ok: boolean;
    checked_components: number;
    checked_pins: number;
    missing_components: string[];
    mismatches: NetlistMismatch[];
};

type ReadbackPin = { pin_number: string | number; signal_name?: string | null };
type ReadbackComponent = { designator: string; pins: ReadbackPin[] };

/**
 * Parse a Protel 2 netlist. Blocks are delimited by lines holding only "[" / "]"
 * (components) or "(" / ")" (nets), so part numbers such as "EL3H7(B)(TA)-G"
 * inside member lines do not break parsing.
 */
export function parseProtelNetlist(text: string): ParsedNetlist {
    const nets: Record<string, string[]> = {};
    const components: string[] = [];
    let mode: 'none' | 'component' | 'net' = 'none';
    let header: string | null = null;
    let expectDesignator = false;
    let members: string[] = [];

    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (mode === 'none') {
            if (line === '[') { mode = 'component'; expectDesignator = false; }
            else if (line === '(') { mode = 'net'; header = null; members = []; }
            continue;
        }
        if (mode === 'component') {
            if (line === ']') { mode = 'none'; continue; }
            if (expectDesignator && line) { components.push(line); expectDesignator = false; continue; }
            if (line === 'DESIGNATOR') expectDesignator = true;
            continue;
        }
        if (line === ')') {
            if (header) nets[header] = members;
            mode = 'none';
            continue;
        }
        if (!line) continue;
        if (header === null) header = line.split(/\s+/)[0];
        else members.push(line.split(/\s+/)[0]);
    }
    return { nets, components };
}

/** Map "DESIGNATOR-PIN" -> net name. */
export function pinNetIndex(nets: Record<string, string[]>) {
    const index = new Map<string, string>();
    for (const [net, members] of Object.entries(nets)) {
        for (const member of members) index.set(member, net);
    }
    return index;
}

function baseDesignator(value: string) {
    return value.trim().replace(/\.\d+$/, '');
}

/** Compare an expectation with a parsed netlist. Pins absent from every net count as unconnected (''). */
export function compareNetlist(expected: ExpectedNetlist, parsed: ParsedNetlist): NetlistComparison {
    const index = pinNetIndex(parsed.nets);
    const present = new Set(parsed.components.map(baseDesignator));
    for (const member of index.keys()) present.add(member.slice(0, member.lastIndexOf('-')));

    const missing_components: string[] = [];
    const mismatches: NetlistMismatch[] = [];
    let checked_pins = 0;

    for (const [designator, pins] of Object.entries(expected)) {
        if (!present.has(designator)) {
            missing_components.push(designator);
            continue;
        }
        for (const [pin, net] of Object.entries(pins)) {
            checked_pins++;
            const actual = index.get(`${designator}-${pin}`) ?? '';
            if (actual !== net) mismatches.push({ designator, pin, expected: net, actual });
        }
    }
    return {
        ok: !missing_components.length && !mismatches.length,
        checked_components: Object.keys(expected).length - missing_components.length,
        checked_pins,
        missing_components,
        mismatches,
    };
}

/** Compare requested component pins with a page readback (get-schematic). */
export function compareReadback(expected: ExpectedNetlist, components: ReadbackComponent[]): NetlistComparison {
    const byDesignator = new Map(components.map(component => [baseDesignator(component.designator), component]));
    const missing_components: string[] = [];
    const mismatches: NetlistMismatch[] = [];
    let checked_pins = 0;

    for (const [designator, pins] of Object.entries(expected)) {
        const component = byDesignator.get(designator);
        if (!component) {
            missing_components.push(designator);
            continue;
        }
        const actualPins = new Map(component.pins.map(pin => [String(pin.pin_number), pin.signal_name ?? '']));
        for (const [pin, net] of Object.entries(pins)) {
            checked_pins++;
            const actual = actualPins.get(pin) ?? '';
            if (actual !== net) mismatches.push({ designator, pin, expected: net, actual });
        }
    }
    return {
        ok: !missing_components.length && !mismatches.length,
        checked_components: Object.keys(expected).length - missing_components.length,
        checked_pins,
        missing_components,
        mismatches,
    };
}

/** Convert a page or multi-page readback into the expectation format. */
export function readbackToExpected(components: ReadbackComponent[]): ExpectedNetlist {
    return Object.fromEntries(components.map(component => [
        baseDesignator(component.designator),
        Object.fromEntries(component.pins.map(pin => [String(pin.pin_number), pin.signal_name ?? ''])),
    ]));
}

/** Designators that EasyEDA left unannotated, such as "U?" or "R?". */
export function unannotatedDesignators(components: ReadbackComponent[]) {
    return components.map(component => component.designator).filter(designator => /\?/.test(designator));
}

function globToRegExp(pattern: string) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`);
}

/** True when the net name matches any glob pattern (e.g. "F_*"). */
export function matchesAny(name: string, patterns: string[]) {
    return patterns.some(pattern => globToRegExp(pattern).test(name));
}

/**
 * Groups of distinct net names that collapse to the same key after removing
 * case and inner punctuation (e.g. "VSS"/"Vss", "RS485_A"/"RS485-A"). A leading
 * sign is kept, so "+24V" and "-24V" stay distinct.
 */
export function similarNetNames(names: string[]) {
    const groups = new Map<string, Set<string>>();
    for (const name of names) {
        if (/^\$/.test(name)) continue;
        const sign = /^[+-]/.test(name) ? name[0] : '';
        const key = sign + name.slice(sign.length).toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, new Set());
        groups.get(key)!.add(name);
    }
    return [...groups.values()].filter(group => group.size > 1).map(group => [...group].sort());
}

/** Keep a result list bounded while reporting the full count. */
export function limited<T>(items: T[], limit: number) {
    return { count: items.length, items: items.slice(0, limit), ...(items.length > limit ? { truncated: true } : {}) };
}
