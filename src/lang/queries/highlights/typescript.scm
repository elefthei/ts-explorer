; Generic patterns come first: later captures win when spans overlap.
(identifier) @variableName
(type_identifier) @typeName
(predefined_type) @typeName
(property_identifier) @propertyName
(private_property_identifier) @propertyName
(shorthand_property_identifier) @propertyName
(statement_identifier) @labelName
(comment) @comment
(string) @string
(template_string) @string2
(regex) @string2
(number) @number
[(true) (false)] @bool
[(null) (undefined)] @atom
(this) @variableName2
(super) @variableName2
[
  "abstract" "accessor" "as" "async" "await" "break" "case" "catch" "class" "const"
  "continue" "declare" "default" "delete" "do" "else" "enum" "export" "extends"
  "finally" "for" "from" "function" "get" "if" "implements" "import" "in" "instanceof"
  "interface" "keyof" "let" "namespace" "new" "of" "override" "private" "protected"
  "public" "readonly" "return" "satisfies" "set" "static" "switch" "throw" "try"
  "type" "typeof" "var" "void" "while" "yield"
] @keyword
[
  "+" "-" "*" "/" "%" "=" "==" "===" "!=" "!==" "<" ">" "<=" ">=" "&&" "||" "!" "?"
  "=>" "..." "&" "|" "??"
] @operator
["(" ")" "[" "]" "{" "}" ";" "," "." ":"] @punctuation
(class_declaration name: (type_identifier) @className)
(abstract_class_declaration name: (type_identifier) @className)
(interface_declaration name: (type_identifier) @className)
(enum_declaration name: (identifier) @className)
(type_alias_declaration name: (type_identifier) @className)
(function_declaration name: (identifier) @definition)
(method_definition name: (property_identifier) @definition)
(ERROR) @invalid
