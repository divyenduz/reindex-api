import {Record} from 'immutable';
import isConnection from '../../schema/fields/isConnection';
import isNode from '../../schema/fields/isNode';

/**
 * Validator that checks that there is a non connection field with parameter's
 * name, for a type with typeParameter's name.
 */
export default class IsFieldValidator extends Record({
  typeParameter: undefined,
}) {
  validate(schema, name, parameters) {
    let existingType = schema.types.get(parameters.get(this.typeParameter));
    if (existingType) {
      let existingField = existingType.fields.get(name);
      if (!existingField) {
        throw new Error(
          `Type "${existingType.name}" does not have a field "${name}".`
        );
      } else if (isConnection(existingField) || isNode(existingField)) {
        throw new Error(
          `Field "${name}" of "${existingType.name}" is a connection. ` +
          `Expected a non connection field.`
        );
      }
    }
    return true;
  }
}