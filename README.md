# AutoDJ · app para Android

El mezclador automático [AutoDJ](https://github.com/luis072602/AutoDJ) como aplicación de Android: busca cualquier
canción de YouTube Music, detecta su BPM, intro y final, y las mezcla al compás, con ecualizador de 5 bandas.
Todo ocurre en el teléfono: no necesita PC ni servidor.

Uso personal. Obtener audio de YouTube va contra sus condiciones de servicio, por eso esta app no está (ni puede estar) en Google Play.

## Instalar

1. En el teléfono, descarga **[AutoDJ.apk](https://github.com/luis072602/AutoDJ-Apk/releases/latest/download/AutoDJ.apk)**.
2. Ábrelo. Android pedirá permiso para «instalar apps desconocidas» desde el navegador o el gestor de archivos: acéptalo.
3. Para actualizar, repite los pasos: se instala encima de la anterior sin perder nada.

Requiere Android 8.0 o superior.

## Usar

- Busca una canción o artista, toca una búsqueda rápida, o pega el enlace de una lista de YouTube.
- Toca una canción para agregarla (o «Agregar todas») y pulsa **Reproducir**. La mezcla es automática.
- **Mezclar ya** fuerza el cruce; tocar una canción de la lista mezcla hacia ella; tocar la onda salta a ese punto.
- La pantalla se mantiene encendida mientras la app está abierta: si se apaga, Android corta la mezcla.

## Cómo está hecha

    app/src/main/assets/www/     la interfaz (HTML, CSS y JS), la misma del AutoDJ web
    app/src/main/java/…/
      MainActivity.java          muestra la interfaz en un WebView y desvía las rutas /api/…
      YouTube.java               atiende /api/search, /api/playlist y /api/audio en el teléfono
      OkDownloader.java          conexión de red para NewPipeExtractor
    .github/workflows/build.yml  GitHub compila el APK en cada cambio y lo publica en Releases
    dev_server.py                imita /api/… en el PC para probar la interfaz en un navegador

La búsqueda y el audio de YouTube los resuelve [NewPipeExtractor](https://github.com/TeamNewPipe/NewPipeExtractor).

## Si deja de funcionar

YouTube cambia cosas cada cierto tiempo. Casi siempre se arregla subiendo la versión de NewPipeExtractor en
`app/build.gradle` a la [última publicada](https://github.com/TeamNewPipe/NewPipeExtractor/releases) y volviendo a compilar.

## Firma

`app/autodj.keystore` (creada por el flujo de GitHub la primera vez) firma todas las versiones para que se actualicen
entre sí. Está en el repositorio con su clave a la vista: sirve para una app personal, no para una publicada.
