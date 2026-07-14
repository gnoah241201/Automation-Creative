import { RenderSpec } from '../../shared/render-contract';

const getOutputDimensions = (ratio: RenderSpec['outputRatio']) => {
  switch (ratio) {
    case '9:16':
      return { w: 1080, h: 1920 };
    case '16:9':
      return { w: 1920, h: 1080 };
    case '4:5':
      return { w: 1080, h: 1350 };
    case '1:1':
      return { w: 1080, h: 1080 };
  }
};

const shouldShowOverlays = (inputRatio: RenderSpec['inputRatio'], outputRatio: RenderSpec['outputRatio']) => {
  return (inputRatio === '16:9' && ['9:16', '4:5', '1:1'].includes(outputRatio)) ||
    (inputRatio === '9:16' && outputRatio === '16:9');
};

const loadImage = (src: string) => {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
};

export const createOverlayPng = async (
  spec: RenderSpec,
  assets: {
    logoUrl?: string | null;
    logoFile?: File | null;
    buttonImageUrl?: string | null;
    buttonImageFile?: File | null;
  }
): Promise<Blob | null> => {
  if (!shouldShowOverlays(spec.inputRatio, spec.outputRatio)) {
    return null;
  }

  const { w: width, h: height } = getOutputDimensions(spec.outputRatio);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return null;
  }

  ctx.clearRect(0, 0, width, height);

  const getLogicalDimensions = (ratio: RenderSpec['outputRatio']) => {
    switch (ratio) {
      case '9:16':
        return { w: 360, h: 640 };
      case '16:9':
        return { w: 640, h: 360 };
      case '4:5':
        return { w: 400, h: 500 };
      case '1:1':
        return { w: 450, h: 450 };
    }
  };

  const logical = getLogicalDimensions(spec.outputRatio);
  const outScale = width / logical.w;

  ctx.save();
  ctx.scale(outScale, outScale);

  let logoCenterX = 0;
  let logoCenterY = 0;
  let logoContainerW = 0;
  let logoContainerH = 0;
  let buttonCenterX = 0;
  let buttonCenterY = 0;
  let buttonContainerW = 0;
  let buttonContainerH = 0;

  const isVerticalStack = spec.inputRatio === '16:9';

  if (isVerticalStack) {
    const logicalFgH = (logical.w * 9) / 16;
    const flex1H = (logical.h - logicalFgH) / 2;

    logoContainerW = logical.w - 32;
    logoContainerH = flex1H - 32;
    logoCenterX = logical.w / 2;
    logoCenterY = flex1H / 2;

    buttonContainerW = logical.w - 32;
    buttonContainerH = flex1H - 32;
    buttonCenterX = logical.w / 2;
    buttonCenterY = logical.h - (flex1H / 2);
  } else {
    const logicalFgW = (logical.h * 9) / 16;

    // Determine which overlays are present for flexible layout
    const hasLogo = !!(assets.logoFile || assets.logoUrl);
    const hasButton = (spec.buttonType === 'text' && !!spec.buttonText) || (spec.buttonType === 'image' && !!(assets.buttonImageFile || assets.buttonImageUrl));

    if (spec.fgPosition === 'right') {
      const leftSpaceW = logical.w - logicalFgW - 40;
      const usableH = logical.h - 48;

      if (hasLogo && hasButton) {
        // Both present: original 2/3 + 1/3 split
        const logoH = (usableH - 16) * (2 / 3);
        const buttonH = (usableH - 16) * (1 / 3);

        logoContainerW = leftSpaceW - 32;
        logoContainerH = logoH;
        logoCenterX = leftSpaceW / 2;
        logoCenterY = 24 + logoH / 2;

        buttonContainerW = leftSpaceW - 32;
        buttonContainerH = buttonH;
        buttonCenterX = leftSpaceW / 2;
        buttonCenterY = 24 + logoH + 16 + buttonH / 2;
      } else if (hasLogo) {
        // Only logo: full height
        logoContainerW = leftSpaceW - 32;
        logoContainerH = usableH;
        logoCenterX = leftSpaceW / 2;
        logoCenterY = logical.h / 2;
      } else if (hasButton) {
        // Only button: full height
        buttonContainerW = leftSpaceW - 32;
        buttonContainerH = usableH;
        buttonCenterX = leftSpaceW / 2;
        buttonCenterY = logical.h / 2;
      }
    } else if (spec.fgPosition === 'left') {
      const rightSpaceW = logical.w - logicalFgW - 40;
      const usableH = logical.h - 48;

      if (hasLogo && hasButton) {
        // Both present: original 2/3 + 1/3 split
        const logoH = (usableH - 16) * (2 / 3);
        const buttonH = (usableH - 16) * (1 / 3);

        logoContainerW = rightSpaceW - 32;
        logoContainerH = logoH;
        logoCenterX = logical.w - rightSpaceW + (rightSpaceW / 2);
        logoCenterY = 24 + logoH / 2;

        buttonContainerW = rightSpaceW - 32;
        buttonContainerH = buttonH;
        buttonCenterX = logical.w - rightSpaceW + (rightSpaceW / 2);
        buttonCenterY = 24 + logoH + 16 + buttonH / 2;
      } else if (hasLogo) {
        // Only logo: full height
        logoContainerW = rightSpaceW - 32;
        logoContainerH = usableH;
        logoCenterX = logical.w - rightSpaceW + (rightSpaceW / 2);
        logoCenterY = logical.h / 2;
      } else if (hasButton) {
        // Only button: full height
        buttonContainerW = rightSpaceW - 32;
        buttonContainerH = usableH;
        buttonCenterX = logical.w - rightSpaceW + (rightSpaceW / 2);
        buttonCenterY = logical.h / 2;
      }
    } else {
      const sideSpaceW = (logical.w - logicalFgW) / 2;

      logoContainerW = sideSpaceW - 32;
      logoContainerH = logical.h - 48;
      logoCenterX = sideSpaceW / 2;
      logoCenterY = logical.h / 2;

      buttonContainerW = sideSpaceW - 32;
      buttonContainerH = logical.h - 48;
      buttonCenterX = logical.w - (sideSpaceW / 2);
      buttonCenterY = logical.h / 2;
    }
  }

  const logoSource = assets.logoFile ? URL.createObjectURL(assets.logoFile) : assets.logoUrl;
  const buttonImageSource = assets.buttonImageFile ? URL.createObjectURL(assets.buttonImageFile) : assets.buttonImageUrl;

  if (logoSource) {
    try {
      const img = await loadImage(logoSource);
      const drawW = img.width;
      const drawH = img.height;
      const maxScale = Math.min(1, logoContainerW / drawW, logoContainerH / drawH);
      const logicalDrawW = drawW * maxScale;
      const logicalDrawH = drawH * maxScale;

      const uiScale = spec.logoSize / 100;
      const finalX = logoCenterX + spec.logoX;
      const finalY = logoCenterY + spec.logoY;

      ctx.save();
      ctx.translate(finalX, finalY);
      ctx.scale(uiScale, uiScale);
      ctx.shadowColor = 'rgba(0,0,0,0.3)';
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 4;
      ctx.drawImage(img, -logicalDrawW / 2, -logicalDrawH / 2, logicalDrawW, logicalDrawH);
      ctx.restore();
    } catch (error) {
      console.error('Failed to draw logo overlay:', error);
    } finally {
      if (assets.logoFile) {
        URL.revokeObjectURL(logoSource);
      }
    }
  }

  if (spec.buttonType === 'image' && buttonImageSource) {
    try {
      const img = await loadImage(buttonImageSource);
      const drawW = img.width;
      const drawH = img.height;
      const maxScale = Math.min(1, buttonContainerW / drawW, buttonContainerH / drawH);
      const logicalDrawW = drawW * maxScale;
      const logicalDrawH = drawH * maxScale;

      const uiScale = spec.buttonSize / 100;
      const finalX = buttonCenterX + spec.buttonX;
      const finalY = buttonCenterY + spec.buttonY;

      ctx.save();
      ctx.translate(finalX, finalY);
      ctx.scale(uiScale, uiScale);
      ctx.shadowColor = 'rgba(0,0,0,0.3)';
      ctx.shadowBlur = 15;
      ctx.shadowOffsetY = 5;
      ctx.drawImage(img, -logicalDrawW / 2, -logicalDrawH / 2, logicalDrawW, logicalDrawH);
      ctx.restore();
    } catch (error) {
      console.error('Failed to draw button image overlay:', error);
    } finally {
      if (assets.buttonImageFile) {
        URL.revokeObjectURL(buttonImageSource);
      }
    }
  } else if (spec.buttonType === 'text' && spec.buttonText) {
    const uiScale = spec.buttonSize / 100;
    const finalX = buttonCenterX + spec.buttonX;
    const finalY = buttonCenterY + spec.buttonY;

    ctx.save();
    ctx.translate(finalX, finalY);
    ctx.scale(uiScale, uiScale);

    const isTextSm = spec.inputRatio === '9:16';
    const fontSize = isTextSm ? 16 : 18;
    const px = isTextSm ? 24 : 32;
    const py = isTextSm ? 8 : 12;
    const lineHeight = isTextSm ? 24 : 28;

    ctx.font = `bold ${fontSize}px system-ui, -apple-system, sans-serif`;
    const textMetrics = ctx.measureText(spec.buttonText);
    const textW = textMetrics.width;

    const btnW = textW + (px * 2);
    const btnH = lineHeight + (py * 2);

    const gradient = ctx.createLinearGradient(0, -btnH / 2, 0, btnH / 2);
    gradient.addColorStop(0, '#FFD700');
    gradient.addColorStop(0.5, '#FFB800');
    gradient.addColorStop(1, '#FF8A00');

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect(-btnW / 2, -btnH / 2, btnW, btnH, btnH / 2);

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 6;
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = '#D2691E';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(spec.buttonText, 0, 0);

    ctx.restore();
  }

  ctx.restore();

  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
};
