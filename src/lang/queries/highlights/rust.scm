; Generic patterns come first: later captures win when spans overlap.
(identifier) @variableName
(type_identifier) @typeName
(primitive_type) @typeName
(field_identifier) @propertyName
(shorthand_field_identifier) @propertyName
(string_literal) @string
(raw_string_literal) @string
(char_literal) @string
(escape_sequence) @string2
(integer_literal) @number
(float_literal) @number
(boolean_literal) @bool
[(self) (super) (crate)] @variableName2
[
  "as" "async" "await" "break" "const" "continue" "default" "dyn" "else" "enum"
  "extern" "fn" "for" "gen" "if" "impl" "in" "let" "loop" "macro_rules!" "match"
  "mod" "move" "pub" "raw" "ref" "return" "static" "struct" "trait" "type"
  "union" "unsafe" "use" "where" "while" "yield"
] @keyword
(mutable_specifier) @keyword
[
  "+" "-" "*" "/" "%" "=" "==" "!=" "<" ">" "<=" ">=" "&&" "||" "!" "&" "|" "^"
  "=>" "?" ".." "..." "..="
] @operator
["(" ")" "[" "]" "{" "}" ";" "," "." ":" "::" "->" "#"] @punctuation
; After the operator/punctuation lists: a `///`/`//!` doc marker holds a nested `/`/`!` token that
; would otherwise repaint the middle of the comment span.
(line_comment) @comment
(block_comment) @comment
(outer_doc_comment_marker "/" @comment)
(inner_doc_comment_marker "!" @comment)
(lifetime) @labelName
(lifetime (identifier) @labelName)
(attribute (identifier) @atom)
(struct_item name: (type_identifier) @className)
(union_item name: (type_identifier) @className)
(enum_item name: (type_identifier) @className)
(trait_item name: (type_identifier) @className)
(type_item name: (type_identifier) @className)
(mod_item name: (identifier) @className)
(enum_variant name: (identifier) @propertyName)
(function_item name: (identifier) @definition)
(function_signature_item name: (identifier) @definition)
(macro_definition name: (identifier) @definition)
(ERROR) @invalid
