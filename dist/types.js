export const OPERATORS = [
    'ComparisonBoundary',
    'Equality',
    'Logical',
    'Arithmetic',
    'UnaryMinus',
    'Update',
    'BooleanLiteral',
    'Negation',
    'Condition',
    'FunctionBody',
    'OptionalChaining',
    'CallUnwrap',
    'CallStatement',
    'Regex',
];
export function isOperator(name) {
    return OPERATORS.includes(name);
}
