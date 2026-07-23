// Builds a parameterized "col1 = $1, col2 = $2" SET clause from whichever of
// `columns` are present in `body`, starting parameter numbering at `startIndex`.
module.exports = function buildSetClause(columns, body, startIndex = 1) {
 const cols = columns.filter((c) => body[c] !== undefined);
 const setClause = cols.map((c, i) => `${c} = $${startIndex + i}`).join(', ');
 const values = cols.map((c) => body[c]);
 return { cols, setClause, values };
};
