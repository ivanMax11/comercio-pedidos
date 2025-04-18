import { NextResponse } from 'next/server';
import pool from '@/lib/db';

const TIMEZONE = 'America/Argentina/Buenos_Aires';

// Función para obtener precios desde la base de datos
async function getPrecios(client: any) {
  const res = await client.query('SELECT item_key, item_value FROM precio_config');
  const precios: Record<string, number> = {};
  res.rows.forEach((row: any) => {
    precios[row.item_key] = parseFloat(row.item_value);
  });
  return precios;
}

// Función para generar número de pedido único
async function generarNumeroPedido(client: any): Promise<string> {
  const ahora = new Date();
  const opciones = { timeZone: 'America/Argentina/Buenos_Aires' };
  
  const dia = ahora.toLocaleDateString('es-AR', { ...opciones, day: '2-digit' });
  const mes = ahora.toLocaleDateString('es-AR', { ...opciones, month: '2-digit' });
  const año = ahora.toLocaleDateString('es-AR', { ...opciones, year: 'numeric' });
  const hoyFormatoLocal = `${dia}-${mes}-${año}`;
  const hoyStr = `${año}-${mes}-${dia}`;

  await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');

  try {
    const res = await client.query(
      `SELECT numero_pedido FROM pedidos 
       WHERE fecha_pedido = $1 
       ORDER BY numero_pedido DESC 
       LIMIT 1
       FOR UPDATE`,
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

    const existe = await client.query(
      `SELECT 1 FROM pedidos WHERE numero_pedido = $1 LIMIT 1`,
      [numeroPedido]
    );

    if (existe.rows.length > 0) {
      throw new Error('Número de pedido duplicado');
    }

    await client.query('COMMIT');
    return numeroPedido;

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error en generarNumeroPedido:', error);
    throw new Error('Error al generar número de pedido');
  }
}

// Función para calcular el precio total basado en los precios dinámicos
async function calcularPrecioTotal(client: any, data: any) {
  const precios = await getPrecios(client);
  const precioUnitario = Number(data.precioUnitario);
  let precioTotal = 0;
  const cantidadEntera = Math.floor(data.cantidadPollo);
  const tieneMedioPollo = data.cantidadPollo % 1 !== 0;

  // Precio base por pollos enteros
  precioTotal += cantidadEntera * precioUnitario;

  // Recargo por medio pollo
  if (tieneMedioPollo) {
    precioTotal += (precioUnitario / 2) + precios.medio_pollo_recargo;
  }

  // Costo de envío
  if (data.tipoEntrega === 'envio') {
    switch(data.tipoEnvio) {
      case 'cercano': 
        precioTotal += precios.envio_cercano; 
        break;
      case 'lejano': 
        precioTotal += precios.envio_lejano; 
        break;
      case 'la_banda': 
        precioTotal += precios.envio_la_banda; 
        break;
    }
  }

  // Costo de papas
  if (data.conPapas && data.cantidadPapas > 0) {
    precioTotal += data.cantidadPapas * precios.papas_precio;
  }

  return precioTotal;
}

// Endpoint GET para obtener pedidos
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const fecha = searchParams.get('fecha');
  
  try {
    const client = await pool.connect();
    
    let query = `
      SELECT 
        id,
        numero_pedido,
        nombre_cliente,
        telefono_cliente,
        tipo_entrega,
        tipo_envio,
        direccion,
        metodo_pago,
        con_chimichurri,
        con_papas,
        cantidad_papas,
        cantidad_pollo,
        precio_unitario,
        precio_total,
        fecha_pedido,
        estado,
        -- Formateamos las horas directamente en la consulta
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
    client.release();

    return NextResponse.json({
      success: true,
      data: result.rows
    });
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
    console.error('Error en GET /api/pedidos:', errorMessage);
    return NextResponse.json(
      { 
        success: false,
        error: 'Error al obtener pedidos',
        details: process.env.NODE_ENV === 'development' ? errorMessage : null
      },
      { status: 500 }
    );
  }
}

// Endpoint POST para crear nuevos pedidos
export async function POST(request: Request) {
  let client;
  try {
    if (!request.headers.get('content-type')?.includes('application/json')) {
      return NextResponse.json(
        { success: false, error: 'Content-Type debe ser application/json' },
        { status: 400 }
      );
    }

    const data = await request.json();
    
    const requiredFields = [
      'nombre', 'tipoEntrega', 'metodoPago', 
      'cantidadPollo', 'precioUnitario',
      'horaEntrega'
    ];
    const missingFields = requiredFields.filter(field => !data[field]);
    
    if (missingFields.length > 0) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'Faltan campos requeridos',
          missingFields 
        },
        { status: 400 }
      );
    }

    // Validar cantidad de pollo
    if (data.cantidadPollo <= 0 || data.cantidadPollo % 0.5 !== 0) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'La cantidad debe ser mayor a 0 y múltiplo de 0.5 (ej: 0.5, 1, 1.5)' 
        },
        { status: 400 }
      );
    }

    client = await pool.connect();
    
    // Verificar stock
    const stockResult = await client.query(
      'SELECT cantidad FROM stock WHERE producto = $1',
      ['pollo']
    );
    const stockDisponible = parseFloat(stockResult.rows[0]?.cantidad) || 0;
    
    if (stockDisponible < data.cantidadPollo) {
      return NextResponse.json(
        { 
          success: false, 
          error: `Stock insuficiente. Disponible: ${stockDisponible}` 
        },
        { status: 400 }
      );
    }

    // Calcular precio total con precios dinámicos
    const precioTotal = await calcularPrecioTotal(client, data);
    const precioUnitario = Number(data.precioUnitario);

    const numeroPedido = await generarNumeroPedido(client);
    await client.query('BEGIN');
    
    const result = await client.query(
      `INSERT INTO pedidos (
        numero_pedido,
        nombre_cliente,
        telefono_cliente,
        tipo_entrega,
        tipo_envio,
        direccion,
        metodo_pago,
        con_chimichurri,
        con_papas,
        cantidad_papas,
        cantidad_pollo,
        precio_unitario,
        precio_total,
        fecha,
        hora_pedido,
        fecha_pedido,
        hora_entrega_solicitada,
        estado
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
        NOW() AT TIME ZONE $14,
        (NOW() AT TIME ZONE $14)::time,
        (NOW() AT TIME ZONE $14)::date,
        $15,
        'pendiente'
      ) RETURNING id, numero_pedido`,
      [
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
        precioUnitario,
        precioTotal,
        TIMEZONE,
        data.horaEntrega
      ]
    );

    await client.query(
      'UPDATE stock SET cantidad = cantidad - $1 WHERE producto = $2',
      [data.cantidadPollo, 'pollo']
    );

    await client.query('COMMIT');
    client.release();
    
    return NextResponse.json({
      success: true,
      message: 'Pedido registrado con éxito',
      pedidoId: result.rows[0].id,
      numeroPedido: result.rows[0].numero_pedido,
      total: precioTotal
    });
    
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK').catch(e => console.error('Error en ROLLBACK:', e));
      client.release();
    }
    
    const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
    console.error('Error en POST /api/pedidos:', errorMessage);

    return NextResponse.json(
      { 
        success: false,
        error: 'Error al registrar el pedido',
        details: process.env.NODE_ENV === 'development' ? errorMessage : null
      },
      { status: 500 }
    );
  }
}

// Endpoint PATCH para actualizar estado de pedidos
export async function PATCH(request: Request) {
  let client;
  try {
    if (!request.headers.get('content-type')?.includes('application/json')) {
      return NextResponse.json(
        { success: false, error: 'Content-Type debe ser application/json' },
        { status: 400 }
      );
    }

    const { id, estado } = await request.json();

    if (!id || !estado) {
      return NextResponse.json(
        { success: false, error: 'Se requieren ID y estado' },
        { status: 400 }
      );
    }

    const estadosValidos = ['pendiente', 'preparando', 'en_camino', 'entregado', 'cancelado'];
    if (!estadosValidos.includes(estado)) {
      return NextResponse.json(
        { success: false, error: 'Estado no válido' },
        { status: 400 }
      );
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Obtener el estado actual y cantidad de pollos del pedido
    const pedidoActual = await client.query(
      `SELECT estado, cantidad_pollo 
       FROM pedidos 
       WHERE id = $1 
       FOR UPDATE`,
      [id]
    );

    if (pedidoActual.rowCount === 0) {
      await client.query('ROLLBACK');
      client.release();
      return NextResponse.json(
        { success: false, error: 'Pedido no encontrado' },
        { status: 404 }
      );
    }

    const estadoAnterior = pedidoActual.rows[0].estado;
    const cantidadPollo = parseFloat(pedidoActual.rows[0].cantidad_pollo);

    // Actualizar el estado del pedido
    let query = 'UPDATE pedidos SET estado = $1';
    const params = [estado];

    if (estado === 'entregado') {
      query += ', hora_entrega_real = NOW() AT TIME ZONE $2';
      params.push(TIMEZONE);
    }

    query += ' WHERE id = $' + (params.length + 1) + ' RETURNING *';
    params.push(id);

    const result = await client.query(query, params);

    // Devolver pollos al stock si se cancela
    if (estado === 'cancelado' && ['pendiente', 'preparando'].includes(estadoAnterior)) {
      await client.query(
        `UPDATE stock 
         SET cantidad = cantidad + $1 
         WHERE producto = 'pollo'`,
        [cantidadPollo]
      );
      console.log(`♻️ Devolviendo ${cantidadPollo} pollos al stock (Pedido ${id})`);
    }

    await client.query('COMMIT');
    client.release();

    return NextResponse.json({
      success: true,
      message: 'Estado actualizado',
      data: result.rows[0]
    });

  } catch (error) {
    if (client) {
      await client.query('ROLLBACK').catch(e => console.error('Error en ROLLBACK:', e));
      client.release();
    }
    
    const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
    console.error('Error en PATCH /api/pedidos:', errorMessage);

    return NextResponse.json(
      { 
        success: false,
        error: 'Error al actualizar estado',
        details: process.env.NODE_ENV === 'development' ? errorMessage : null
      },
      { status: 500 }
    );
  }
}

// Endpoint PUT para editar pedidos existentes
export async function PUT(request: Request) {
  let client;
  try {
    if (!request.headers.get('content-type')?.includes('application/json')) {
      return NextResponse.json(
        { success: false, error: 'Content-Type debe ser application/json' },
        { status: 400 }
      );
    }

    const data = await request.json();
    
    if (!data.id) {
      return NextResponse.json(
        { success: false, error: 'Se requiere el ID del pedido' },
        { status: 400 }
      );
    }

    const requiredFields = [
      'nombre', 'tipoEntrega', 'metodoPago', 
      'cantidadPollo', 'precioUnitario',
      'horaEntrega'
    ];
    const missingFields = requiredFields.filter(field => !data[field]);
    
    if (missingFields.length > 0) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'Faltan campos requeridos',
          missingFields 
        },
        { status: 400 }
      );
    }

    // Validar cantidad de pollo
    if (data.cantidadPollo <= 0 || data.cantidadPollo % 0.5 !== 0) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'La cantidad debe ser mayor a 0 y múltiplo de 0.5 (ej: 0.5, 1, 1.5)' 
        },
        { status: 400 }
      );
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Obtener el pedido actual para comparar cantidades
    const pedidoActual = await client.query(
      `SELECT cantidad_pollo, estado FROM pedidos WHERE id = $1 FOR UPDATE`,
      [data.id]
    );

    if (pedidoActual.rowCount === 0) {
      await client.query('ROLLBACK');
      client.release();
      return NextResponse.json(
        { success: false, error: 'Pedido no encontrado' },
        { status: 404 }
      );
    }

    const cantidadAnterior = parseFloat(pedidoActual.rows[0].cantidad_pollo);
    const estadoActual = pedidoActual.rows[0].estado;

    // No permitir editar pedidos entregados o cancelados
    if (['entregado', 'cancelado'].includes(estadoActual)) {
      await client.query('ROLLBACK');
      client.release();
      return NextResponse.json(
        { 
          success: false, 
          error: `No se puede editar un pedido ${estadoActual}` 
        },
        { status: 400 }
      );
    }

    // Verificar stock (solo si cambió la cantidad)
    const diferenciaCantidad = data.cantidadPollo - cantidadAnterior;
    
    if (diferenciaCantidad > 0) {
      const stockResult = await client.query(
        'SELECT cantidad FROM stock WHERE producto = $1',
        ['pollo']
      );
      const stockDisponible = parseFloat(stockResult.rows[0]?.cantidad) || 0;
      
      if (stockDisponible < diferenciaCantidad) {
        await client.query('ROLLBACK');
        client.release();
        return NextResponse.json(
          { 
            success: false, 
            error: `Stock insuficiente para actualizar. Disponible: ${stockDisponible}, Necesario: ${diferenciaCantidad}` 
          },
          { status: 400 }
        );
      }
    }

    // Calcular nuevo precio total con precios dinámicos
    const precioTotal = await calcularPrecioTotal(client, data);
    const precioUnitario = Number(data.precioUnitario);

    // Actualizar el pedido
    const result = await client.query(
      `UPDATE pedidos SET
        nombre_cliente = $1,
        telefono_cliente = $2,
        tipo_entrega = $3,
        tipo_envio = $4,
        direccion = $5,
        metodo_pago = $6,
        con_chimichurri = $7,
        con_papas = $8,
        cantidad_papas = $9,
        cantidad_pollo = $10,
        precio_unitario = $11,
        precio_total = $12,
        hora_entrega_solicitada = $13,
        fecha_actualizacion = NOW() AT TIME ZONE $14
      WHERE id = $15
      RETURNING *`,
      [
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
        precioUnitario,
        precioTotal,
        data.horaEntrega,
        TIMEZONE,
        data.id
      ]
    );

    // Ajustar stock según la diferencia
    if (diferenciaCantidad !== 0) {
      await client.query(
        'UPDATE stock SET cantidad = cantidad - $1 WHERE producto = $2',
        [diferenciaCantidad, 'pollo']
      );
    }

    await client.query('COMMIT');
    client.release();
    
    return NextResponse.json({
      success: true,
      message: 'Pedido actualizado con éxito',
      data: result.rows[0],
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
    });
    
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK').catch(e => console.error('Error en ROLLBACK:', e));
      client.release();
    }
    
    const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
    console.error('Error en PUT /api/pedidos:', errorMessage);

    return NextResponse.json(
      { 
        success: false,
        error: 'Error al actualizar el pedido',
        details: process.env.NODE_ENV === 'development' ? errorMessage : null
      },
      { status: 500 }
    );
  }
}