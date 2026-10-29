export function F(p: { a: boolean; b: boolean }) { return <div>{p.a && <span />}{p.b ? <i /> : <b />}</div>; }
