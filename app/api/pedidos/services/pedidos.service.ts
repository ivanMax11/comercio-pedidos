import pool from '@/lib/db';
import { 
  Pedido, 
  PedidoCreateRequest, 
  PedidoUpdateRequest,
  PedidoCreateResponse 
} from '../types/pedidos.types';
import { calcularPrecioTotal } from './precios.service';
import { generarNumeroPedido as generarNumeroPedidoImportado } from './pedidos.service';  // Renombramos la importación
import { TIMEZONE } from '../utils/fecha.utils';

export async function crearPedido(
  client: any, 
  data: PedidoCreateRequest
): Promise<PedidoCreateResponse> {
  try {
    const precioTotal = await calcularPrecioTotal(client, data);
    const numeroPedido = await generarNumeroPedido(client);
    
    const query = `
      INSERT INTO pedidos (
        client_id, numero_pedido, nombre_cliente, telefono_cliente,
        tipo_entrega, tipo_envio, direccion, metodo_pago,
        con_chimichurri, con_papas, cantidad_papas, cantidad_pollo,
        precio_unitario, precio_total, fecha, hora_pedido, fecha_pedido,
        hora_entrega_solicitada, estado
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        NOW() AT TIME ZONE $15,
        (NOW() AT TIME ZONE $15)::time,
        (NOW() AT TIME ZONE $15)::date,
        $16, 'pendiente'
      )
      RETURNING id, numero_pedido
    `;

    const result = await client.query(query, [
      data.client_id ?? null,  // Manejo de null seguro
      numeroPedido,
      data.nombre,
      data.telefono || null,
      data.tipoEntrega,
      data.tipoEntrega === 'envio' ? data.tipoEnvio : null,
      data.tipoEntrega === 'envio' ? data.direccion : null,
      data.metodoPago,
      data.conChimichurri || false,
      data.conPapas || false,
      data.conPapas ? (data.cantidadPapas || 0) : 0,
      data.cantidadPollo,
      data.precioUnitario,
      precioTotal,
      TIMEZONE,
      data.horaEntrega
    ]);

    // Actualizar stock
    await client.query(
      'UPDATE stock SET cantidad = cantidad - $1 WHERE producto = $2',
      [data.cantidadPollo, 'pollo']
    );

    return {
      pedidoId: result.rows[0].id,
      numeroPedido: result.rows[0].numero_pedido,
      total: precioTotal
    };

  } catch (error) {
    console.error('Error en crearPedido:', error);
    throw error;
  }
}
export async function actualizarPedido(data: PedidoUpdateRequest) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Obtener pedido actual
    const pedidoActual = await client.query(
      `SELECT cantidad_pollo, estado FROM pedidos WHERE id = $1 FOR UPDATE`,
      [data.id]
    );

    if (pedidoActual.rowCount === 0) {
      throw new Error('Pedido no encontrado');
    }

    const cantidadAnterior = parseFloat(pedidoActual.rows[0].cantidad_pollo);
    const estadoActual = pedidoActual.rows[0].estado;

    if (['entregado', 'cancelado'].includes(estadoActual)) {
      throw new Error(`No se puede editar un pedido ${estadoActual}`);
    }

    // Calcular diferencia y verificar stock
    const diferenciaCantidad = data.cantidadPollo - cantidadAnterior;
    
    if (diferenciaCantidad > 0) {
      const stockResult = await client.query(
        'SELECT cantidad FROM stock WHERE producto = $1',
        ['pollo']
      );
      const stockDisponible = parseFloat(stockResult.rows[0]?.cantidad) || 0;
      
      if (stockDisponible < diferenciaCantidad) {
        throw new Error(`Stock insuficiente para actualizar. Disponible: ${stockDisponible}, Necesario: ${diferenciaCantidad}`);
      }
    }

    // Calcular nuevo precio
    const precioTotal = await calcularPrecioTotal(client, data);

    // Actualizar pedido
    const result = await client.query(
      `UPDATE pedidos SET
        nombre_cliente = $1, telefono_cliente = $2, tipo_entrega = $3, tipo_envio = $4,
        direccion = $5, metodo_pago = $6, con_chimichurri = $7, con_papas = $8,
        cantidad_papas = $9, cantidad_pollo = $10, precio_unitario = $11, precio_total = $12,
        hora_entrega_solicitada = $13, fecha_actualizacion = NOW() AT TIME ZONE $14
      WHERE id = $15 RETURNING *`,
      [
        data.nombre, data.telefono || null, data.tipoEntrega,
        data.tipoEntrega === 'envio' ? data.tipoEnvio : null,
        data.tipoEntrega === 'envio' ? data.direccion : null,
        data.metodoPago, data.conChimichurri || false,
        data.conPapas || false, data.conPapas ? (data.cantidadPapas || 0) : 0,
        data.cantidadPollo, data.precioUnitario, precioTotal,
        data.horaEntrega, TIMEZONE, data.id.toString()  // Aseguramos que 'id' sea un string
      ]
    );

    // Ajustar stock
    if (diferenciaCantidad !== 0) {
      await client.query(
        'UPDATE stock SET cantidad = cantidad - $1 WHERE producto = $2',
        [diferenciaCantidad, 'pollo']
      );
    }

    await client.query('COMMIT');
    
    return {
      pedido: result.rows[0],
      cambios: {
        cantidad: {
          anterior: cantidadAnterior,
          nuevo: data.cantidadPollo,
          diferencia: diferenciaCantidad
        },
        precio: {
          nuevoTotal: precioTotal
        }
      }
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function actualizarEstadoPedido(data: { id: number; estado: string }) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Obtener pedido actual
    const pedidoActual = await client.query(
      `SELECT estado, cantidad_pollo FROM pedidos WHERE id = $1 FOR UPDATE`,
      [data.id]
    );

    if (pedidoActual.rowCount === 0) {
      throw new Error('Pedido no encontrado');
    }

    const estadoAnterior = pedidoActual.rows[0].estado;
    const cantidadPollo = parseFloat(pedidoActual.rows[0].cantidad_pollo);

    // Actualizar estado
    let query = 'UPDATE pedidos SET estado = $1';
    const params = [data.estado];

    if (data.estado === 'entregado') {
      query += ', hora_entrega_real = NOW() AT TIME ZONE $2';
      params.push(TIMEZONE);
    }

    query += ' WHERE id = $' + (params.length + 1) + ' RETURNING *';
    params.push(data.id.toString());  // Convertimos 'id' a string

    const result = await client.query(query, params);

    // Devolver stock si se cancela
    if (data.estado === 'cancelado' && ['pendiente', 'preparando'].includes(estadoAnterior)) {
      await client.query(
        `UPDATE stock SET cantidad = cantidad + $1 WHERE producto = 'pollo'`,
        [cantidadPollo]
      );
    }

    await client.query('COMMIT');
    
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function obtenerPedidos(fecha?: string) {
  const client = await pool.connect();
  
  try {
    let query = `
      SELECT 
        id, numero_pedido, nombre_cliente, telefono_cliente, tipo_entrega, tipo_envio,
        direccion, metodo_pago, con_chimichurri, con_papas, cantidad_papas, cantidad_pollo,
        precio_unitario, precio_total, fecha_pedido, estado,
        TO_CHAR(hora_entrega_real, 'HH24:MI') as hora_entrega_real,
        TO_CHAR(hora_entrega_solicitada, 'HH24:MI') as hora_entrega_solicitada,
        TO_CHAR(hora_pedido, 'HH24:MI') as hora_pedido
      FROM pedidos`;
    
    const params = [];
    
    if (fecha) {
      query += ` WHERE fecha_pedido = $1`;
      params.push(fecha);
    }
    
    query += ` ORDER BY 
      CASE 
        WHEN estado = 'entregado' THEN 1
        WHEN estado = 'cancelado' THEN 2
        ELSE 0
      END,
      CASE 
        WHEN hora_entrega_solicitada IS NULL THEN 1
        ELSE 0
      END,
      hora_entrega_solicitada ASC,
      hora_pedido ASC`;

    const result = await client.query(query, params);
    
    return result.rows;
  } catch (error) {
    throw error;
  } finally {
    client.release();
  }
}

// pedidos.service.ts

export async function generarNumeroPedido(client: any): Promise<string> {
  const ahora = new Date();
  const opciones = { timeZone: 'America/Argentina/Buenos_Aires' };

  // Obtener la fecha en formato DD-MM-YYYY y YYYY-MM-DD
  const dia = ahora.toLocaleDateString('es-AR', { ...opciones, day: '2-digit' });
  const mes = ahora.toLocaleDateString('es-AR', { ...opciones, month: '2-digit' });
  const año = ahora.toLocaleDateString('es-AR', { ...opciones, year: 'numeric' });
  const hoyFormatoLocal = `${dia}-${mes}-${año}`;
  const hoyStr = `${año}-${mes}-${dia}`;

  // Obtener el último número de pedido del día
  const res = await client.query(
    `SELECT numero_pedido FROM pedidos 
     WHERE fecha_pedido = $1 
     ORDER BY numero_pedido DESC 
     LIMIT 1 FOR UPDATE`,
    [hoyStr]
  );

  let siguienteNumero: number;
  if (res.rows.length > 0) {
    const ultimoNumero = res.rows[0].numero_pedido;
    const partes = ultimoNumero.split('-');
    siguienteNumero = parseInt(partes[partes.length - 1]) + 1;

    if (isNaN(siguienteNumero)) {
      throw new Error('Formato de número de pedido inválido');
    }
  } else {
    siguienteNumero = 1;
  }

  const numeroPedido = `P-${hoyFormatoLocal}-${siguienteNumero.toString().padStart(3, '0')}`;

  // Verificar si el número ya existe (caso muy raro, pero seguro)
  const existe = await client.query(
    `SELECT 1 FROM pedidos WHERE numero_pedido = $1 LIMIT 1`,
    [numeroPedido]
  );

  if (existe.rows.length > 0) {
    throw new Error(`El número de pedido generado ya existe: ${numeroPedido}`);
  }

  return numeroPedido;
}

