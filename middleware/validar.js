/* Helpers de validación de entrada — úsalos antes de tocar la BD */

const TIPO_DOC_OK  = ['DNI', 'CE', 'PASAPORTE'];
const GENERO_OK    = ['M', 'F'];
const RE_FECHA     = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORA      = /^\d{2}:\d{2}$/;
const RE_EMAIL     = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RE_SOLO_NUMS = /^\d+$/;

/** Devuelve el mensaje de error o null si está ok */
function errorTexto(valor, nombre, { requerido = false, max = 500 } = {}) {
  if (requerido && (!valor || !String(valor).trim()))
    return `${nombre} es obligatorio`;
  if (valor && String(valor).length > max)
    return `${nombre} no puede superar ${max} caracteres`;
  return null;
}

function errorEmail(email) {
  if (!email) return null;
  if (!RE_EMAIL.test(String(email).trim()))
    return 'Email inválido';
  if (email.length > 150) return 'Email demasiado largo';
  return null;
}

function errorDni(dni, tipoDoc = 'DNI') {
  if (!dni) return null;
  if (tipoDoc === 'DNI' && !(/^\d{8}$/.test(String(dni).trim())))
    return 'DNI debe tener exactamente 8 dígitos numéricos';
  if (String(dni).length > 20)
    return 'Documento demasiado largo';
  return null;
}

function errorFecha(valor, nombre) {
  if (!valor) return null;
  if (!RE_FECHA.test(String(valor)))
    return `${nombre} debe tener formato YYYY-MM-DD`;
  const d = new Date(valor);
  if (isNaN(d.getTime()))
    return `${nombre} no es una fecha válida`;
  return null;
}

function errorHora(valor, nombre) {
  if (!valor) return null;
  if (!RE_HORA.test(String(valor)))
    return `${nombre} debe tener formato HH:MM`;
  return null;
}

function errorEnteroPositivo(valor, nombre, { max = 9999 } = {}) {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = parseInt(valor, 10);
  if (isNaN(n) || n < 0)
    return `${nombre} debe ser un número positivo`;
  if (n > max)
    return `${nombre} no puede ser mayor a ${max}`;
  return null;
}

function errorId(valor, nombre = 'ID') {
  const n = parseInt(valor, 10);
  if (isNaN(n) || n <= 0 || !RE_SOLO_NUMS.test(String(valor)))
    return `${nombre} inválido`;
  return null;
}

function errorEnum(valor, nombre, permitidos) {
  if (!valor) return null;
  if (!permitidos.includes(String(valor).toUpperCase()))
    return `${nombre} inválido. Valores permitidos: ${permitidos.join(', ')}`;
  return null;
}

function errorPermisos(permisos) {
  if (permisos === undefined) return null;
  if (!Array.isArray(permisos))
    return 'permisos debe ser un array';
  if (permisos.some(p => typeof p !== 'string' || p.length > 50))
    return 'Cada permiso debe ser un texto de máximo 50 caracteres';
  return null;
}

function errorHistorial(historial) {
  if (!historial) return null;
  if (!Array.isArray(historial))
    return 'historial debe ser un array';
  if (historial.length > 200)
    return 'historial no puede tener más de 200 entradas';
  const json = JSON.stringify(historial);
  if (json.length > 50000)
    return 'historial demasiado grande';
  return null;
}

/** Lanza todos los errores juntos como array, o null si todo ok */
function validar(checks) {
  const errores = checks.filter(Boolean);
  return errores.length ? errores : null;
}

module.exports = {
  validar,
  errorTexto,
  errorEmail,
  errorDni,
  errorFecha,
  errorHora,
  errorEnteroPositivo,
  errorId,
  errorEnum,
  errorPermisos,
  errorHistorial,
  TIPO_DOC_OK,
  GENERO_OK,
};
