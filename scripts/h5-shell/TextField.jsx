import FormControl from '@mui/material/FormControl';
import FormHelperText from '@mui/material/FormHelperText';
import InputLabel from '@mui/material/InputLabel';
import NativeSelect from '@mui/material/NativeSelect';
import OutlinedInput from '@mui/material/OutlinedInput';

// A small outlined text field with the props of Material UI's TextField that this page uses (label, helper text, error, native select,
// multiline, slotProps.htmlInput / input / inputLabel). MUI's own TextField also pulls in its Select, Menu, Popover and the filled and
// standard inputs (about 33 KB minified), which the page never shows: every select here is a native one. The markup, ids and classes are
// the same as TextField's (the id is on the <input>, `<id>-label`, `<id>-helper-text`), so styles and tests do not change.
export default function TextField({
  id, label, helperText, error, select, children, size, fullWidth, sx, className, disabled, required,
  slotProps = {}, inputProps, InputProps, ...input
}) {
  const helperId = helperText && id ? `${id}-helper-text` : undefined;
  const htmlInput = { ...inputProps, ...slotProps.htmlInput, ...(helperId ? { 'aria-describedby': helperId } : {}) };
  const shrink = slotProps.inputLabel && slotProps.inputLabel.shrink;
  const own = { id, label, inputProps: htmlInput, ...(shrink ? { notched: true } : {}), ...InputProps, ...slotProps.input };
  return (
    <FormControl className={className} sx={sx} size={size} fullWidth={fullWidth} error={error} disabled={disabled} required={required} variant="outlined">
      {label != null && label !== '' ? <InputLabel htmlFor={id} id={id ? `${id}-label` : undefined} shrink={shrink}>{label}</InputLabel> : null}
      {select
        ? <NativeSelect {...input} id={id} inputProps={htmlInput} input={<OutlinedInput label={label} {...(shrink ? { notched: true } : {})} />}>{children}</NativeSelect>
        : <OutlinedInput {...input} {...own} />}
      {helperText ? <FormHelperText id={helperId}>{helperText}</FormHelperText> : null}
    </FormControl>
  );
}
