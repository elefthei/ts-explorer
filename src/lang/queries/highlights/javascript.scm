; Generic patterns come first: later captures win when spans overlap.
(identifier) @variableName
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
  "as" "async" "await" "break" "case" "catch" "class" "const" "continue" "default"
  "delete" "do" "else" "export" "extends" "finally" "for" "from" "function" "get"
  "if" "import" "in" "instanceof" "let" "new" "of" "return" "set" "static" "switch"
  "throw" "try" "typeof" "var" "void" "while" "yield"
] @keyword
[
  "+" "-" "*" "/" "%" "=" "==" "===" "!=" "!==" "<" ">" "<=" ">=" "&&" "||" "!" "?"
  "=>" "..." "&" "|" "??"
] @operator
["(" ")" "[" "]" "{" "}" ";" "," "." ":"] @punctuation
(class_declaration name: (identifier) @className)
(function_declaration name: (identifier) @definition)
(method_definition name: (property_identifier) @definition)
(ERROR) @invalid
