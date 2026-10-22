/** Global functions that return a string for every argument, or throw. */
const STRING_FUNCTIONS = new Set(['String', 'encodeURIComponent', 'encodeURI', 'decodeURIComponent', 'decodeURI', 'escape', 'unescape']);
/** Static methods of global objects and what they return. */
const STATICS = new Map([
    ['String', returning('string', ['fromCharCode', 'fromCodePoint', 'raw'])],
    ['Object', returning('array', ['keys', 'values', 'entries'])],
    ['Array', returning('array', ['from', 'of'])],
]);
/**
 * Methods of strings and arrays and what they return, trusted only on a
 * receiver of that kind: any other object may have a method of the same name.
 * `at` is left out (undefined past the end), and so is `match` (null).
 */
const METHODS = new Map([
    ['string', new Map([
            ...returning('string', ['charAt', 'concat', 'normalize', 'padEnd', 'padStart', 'repeat', 'replace', 'replaceAll', 'slice', 'substr',
                'substring', 'toLocaleLowerCase', 'toLocaleUpperCase', 'toLowerCase', 'toString', 'toUpperCase', 'toWellFormed', 'trim', 'trimEnd',
                'trimLeft', 'trimRight', 'trimStart', 'valueOf']),
            ['split', 'array'],
        ])],
    // The copying methods of a plain array build another plain array.
    ['array', new Map([
            ...returning('array', ['concat', 'filter', 'flat', 'flatMap', 'map', 'reverse', 'slice', 'sort', 'toReversed', 'toSorted']),
            ...returning('string', ['join', 'toString']),
        ])],
]);
/**
 * Tells from the syntax of one file that an expression always evaluates to a
 * string, or throws. It answers only when certain, because a `+` it calls a
 * concatenation is not mutated: literals, `typeof`, `String(x)`, string
 * methods on a string, `join()` on an array, a `+` with a string operand,
 * `const` names initialised with such an expression, and names whose
 * TypeScript annotation is a string type. Built-ins are assumed not to be
 * overwritten, as the minifier assumes; a custom `Symbol.replace` or
 * `Symbol.split` is assumed to return what TypeScript's lib types say.
 *
 * It never looks at `let` or `var` initialisers (they may be reassigned),
 * return values, object members, type assertions or JSDoc.
 */
export class Strings {
    bindings;
    /** Per `const` name: what its initialiser is. Null while it is being decided, which ends a cycle. */
    constants = new Map();
    constructor(bindings) {
        this.bindings = bindings;
    }
    /** Whether `node`, where the walk stands, is certainly a string. */
    isString(node) {
        return this.kind(node, this.bindings.getCurrentScope()) === 'string';
    }
    kind(node, scope) {
        switch (node.type) {
            case 'Literal':
                return typeof node.value === 'string' ? 'string' : null;
            case 'TemplateLiteral':
                return 'string';
            case 'ArrayExpression':
                return 'array';
            // Type assertions leave the value alone. `x as string` itself proves nothing:
            // unlike an annotation it is not checked, and narrows `string | number` freely.
            case 'ParenthesizedExpression':
            case 'TSAsExpression':
            case 'TSTypeAssertion':
            case 'TSNonNullExpression':
            case 'TSSatisfiesExpression':
                return this.kind(node.expression, scope);
            case 'UnaryExpression':
                return node.operator === 'typeof' ? 'string' : null;
            case 'BinaryExpression': {
                if (node.operator !== '+')
                    return null;
                // One string operand makes the sum a string.
                return this.kind(node.left, scope) === 'string' || this.kind(node.right, scope) === 'string' ? 'string' : null;
            }
            case 'LogicalExpression':
                // The value is one of the two operands.
                return same(this.kind(node.left, scope), this.kind(node.right, scope));
            case 'ConditionalExpression':
                return same(this.kind(node.consequent, scope), this.kind(node.alternate, scope));
            case 'Identifier':
                return this.name(node.name, scope);
            case 'CallExpression':
                return this.call(node, scope);
            default:
                // Member access, other calls, optional chains, `await` and the rest: anything.
                return null;
        }
    }
    name(name, scope) {
        const declaration = this.bindings.lookup(name, scope);
        // A global: `undefined`, `NaN`, or whatever the environment holds.
        if (!declaration)
            return null;
        if (declaration.type === 'FunctionParam') {
            // Only a parameter that is a plain name carries an annotation; `x?: string` may be undefined.
            const { node } = declaration;
            return node.type === 'Identifier' && !node.optional && node.typeAnnotation ? annotated(node.typeAnnotation.typeAnnotation) : null;
        }
        if (declaration.type !== 'Variable')
            return null;
        const { node: id, variableNode, scope: declared } = declaration;
        // TypeScript checks every assignment against the annotation, as it does for a parameter.
        const stated = id.typeAnnotation ? annotated(id.typeAnnotation.typeAnnotation) : null;
        if (stated)
            return stated;
        // `let` and `var` may be reassigned; a `const` keeps the value of its initialiser.
        if (variableNode.kind !== 'const')
            return null;
        const init = variableNode.declarations.find((declarator) => declarator.id === id)?.init;
        if (!init)
            return null;
        let known = this.constants.get(id);
        if (known === undefined) {
            this.constants.set(id, null);
            // The initialiser's names are resolved where it stands, not where the constant is used.
            known = this.kind(init, declared);
            this.constants.set(id, known);
        }
        return known;
    }
    call(node, scope) {
        const { callee } = node;
        const global = (name) => !this.bindings.lookup(name, scope);
        if (callee.type === 'Identifier')
            return STRING_FUNCTIONS.has(callee.name) && global(callee.name) ? 'string' : null;
        if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier')
            return null;
        const method = callee.property.name;
        const { object } = callee;
        if (object.type === 'Identifier' && STATICS.has(object.name) && global(object.name))
            return STATICS.get(object.name).get(method) ?? null;
        const receiver = this.kind(object, scope);
        return receiver ? METHODS.get(receiver).get(method) ?? null : null;
    }
}
function returning(kind, names) {
    return new Map(names.map((name) => [name, kind]));
}
function same(a, b) {
    return a === b ? a : null;
}
/**
 * The kind a TypeScript type annotation states: `string`, string literal and
 * template literal types, unions of those, and `string & Brand`; array and
 * tuple types.
 */
function annotated(type) {
    switch (type.type) {
        case 'TSStringKeyword':
        case 'TSTemplateLiteralType':
            return 'string';
        case 'TSLiteralType':
            return type.literal.type === 'TemplateLiteral' || (type.literal.type === 'Literal' && typeof type.literal.value === 'string') ? 'string' : null;
        case 'TSArrayType':
        case 'TSTupleType':
            return 'array';
        case 'TSParenthesizedType':
            return annotated(type.typeAnnotation);
        case 'TSUnionType':
            return type.types.map(annotated).reduce(same);
        case 'TSIntersectionType':
            // `any & string` is any.
            if (type.types.some((member) => member.type === 'TSAnyKeyword'))
                return null;
            return type.types.some((member) => annotated(member) === 'string') ? 'string' : null;
        default:
            return null;
    }
}
